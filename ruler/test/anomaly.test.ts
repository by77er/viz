/**
 * Anomaly rules (contract version 2): a PromQL expression watched series by series by a detector
 * from `anomaly/`, evaluated in the ruler's tick, with per-(rule, series) detector state in the
 * ruler's SQLite. What is checked here:
 *
 * - the monitors API: defaults that follow the held-out evidence, errors in the monitor's own
 *   field names, authorisation, and tenant isolation (the tenant comes from the credential only);
 * - alert content: the library's sentence and numbers reach the receiver, and they are the numbers
 *   the library computes on its own for the same points (batch, not the ruler's incremental path);
 * - bounds: the per-rule series cap refuses explicitly and changes nothing, state size limits at
 *   save and at run time, the per-object budget, and state written as whole batches per row;
 * - state is rebuilt from SQLite alone: evictions, replayed ticks and a crash inside the commit
 *   leave exactly the state a run without them has; a newer release's state rows are refused, kept,
 *   and carried by a shard move.
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { DETECTORS } from '../../anomaly/src/index.ts'
import type { AnomalyRuleStatus, MonitorView } from '../contracts-proposal/rules.v2'
import spec from '../openapi.json'
import { ANOMALY_ROW_BYTES, readStateRows, stateRows } from '../src/anomaly'
import { exportRuleFile, importRuleFile } from '../src/rulefile'
import { fingerprint } from '../src/util'
import { apiKey, call } from './api'
import { Crash, T0, tenantWorld, world } from './harness'
import { MIN, newTenant, notifierStub, ok, rulerStub, runNotifierUntil, setup, vec, type ConfigPatch } from './helpers'

/** A deterministic noisy level: 97..103 around 100. */
const noise = (i: number, base = 100) => base + ((i * 37) % 7) - 3
const LAT = 'latency_ms'

type Values = (service: string, i: number) => number | string

/** A tenant with one group of anomaly rules; `values(service, i)` is what `latency_ms` returns at the i-th evaluation time. */
async function rig(rules: unknown[], opts: { patch?: ConfigPatch; services?: string[]; values?: Values; group?: string } = {}) {
  const { tenant, stub, w } = await setup({ heartbeatMs: 30 * MIN, ...opts.patch })
  const saved = ok(await stub.saveGroups(tenant, { groups: [{ name: opts.group ?? 'anomalies/1m', interval: '1m', rules }] }))
  const r = {
    tenant,
    stub,
    w,
    saved,
    services: opts.services ?? ['a', 'b', 'c'],
    values: opts.values ?? ((_s: string, i: number) => noise(i)),
    /** Query times seen, in order: index i is the i-th evaluation time. */
    times: [] as number[],
    tick: async () => {
      world.now = Math.max(world.now, ok(await stub.health(tenant)).alarmAtMs!)
      expect(await runDurableObjectAlarm(stub)).toBe(true)
      return world.now
    },
    status: async (name = 'LatencyAnomaly') => ok(await stub.rules(tenant)).rules.find((x) => x.name === name)!,
    rows: () => runInDurableObject(stub, (_i, s) => s.storage.sql.exec('SELECT tenant, grp, rule_key, chunk, body FROM anomaly_state ORDER BY tenant, grp, rule_key, chunk').toArray()),
  }
  w.evaluate = (q, t) => {
    if (q !== LAT) return vec()
    if (!r.times.includes(t)) r.times.push(t)
    const i = r.times.indexOf(t)
    return vec(...r.services.map((s): [Record<string, string>, number | string] => [{ service: s }, r.values(s, i)]))
  }
  return r
}

const ewmaRule = (extra: Record<string, unknown> = {}, anomaly: Record<string, unknown> = {}) => ({
  alert: 'LatencyAnomaly',
  expr: LAT,
  ...extra,
  anomaly: { params: { halfLifePoints: 10, minPoints: 5 }, unit: 'ms', ...anomaly },
})

/** The stored state of one series, decoded. */
function seriesState(rows: Record<string, unknown>[], service: string) {
  const read = readStateRows(rows.map((r) => r.body as string))
  if ('error' in read) throw new Error(read.error)
  return [...read.series.values()].find((s) => s.labels.service === service)
}

/** What the library computes on its own for the same points, in one batch call from no state. */
function libraryBatch(detector: keyof typeof DETECTORS, params: Record<string, unknown>, ts: number[], values: number[]) {
  const det = DETECTORS[detector] as unknown as { detect(s: unknown, p: unknown, st: unknown): { points: { anomalous: boolean; status: string; explanation?: { text: string; value: number; reference: number; deviations?: number } }[]; state: unknown } }
  return det.detect({ ts: Float64Array.from(ts), values: Float64Array.from(values) }, { ...params, stepMs: MIN }, null)
}

describe('alerts from anomaly rules: the detector decides, the alert state machine and the notifier do the rest', () => {
  it('only the anomalous series fires; the receiver gets the library\'s sentence and numbers, which equal a batch run of the library on the same points; severity routes', async () => {
    const r = await rig([ewmaRule({ annotations: { summary: '{{ $labels.service }} latency is unusual' } }), { alert: 'ErrorsPage', expr: 'errors', anomaly: { severity: 'page', params: { above: 5 } } }], {
      values: (s, i) => (s === 'b' && i === 8 ? 300 : noise(i)),
    })
    const errors: number[] = []
    const base = r.w.evaluate
    r.w.evaluate = (q, t) => {
      if (q !== 'errors') return base(q, t)
      errors.push(t)
      return vec([{ job: 'api' }, errors.length === 9 ? 9 : 1])
    }
    const notifier = notifierStub(r.tenant)
    ok(await notifier.setConfig(r.tenant, {
      route: { receiver: 'tickets', group_by: ['alertname'], group_wait: '0s', group_interval: '1m', repeat_interval: '4h', routes: [{ match: { severity: 'page' }, receiver: 'pager' }] },
      receivers: [{ name: 'tickets', webhook_configs: [{ url: 'https://tickets.test/hook' }] }, { name: 'pager', webhook_configs: [{ url: 'https://pager.test/hook' }] }],
    }))
    // The page rule had no detector named: severity page makes it a static threshold (D33).
    expect(r.saved.groups[0]!.rules.map((x) => x.name)).toEqual(['LatencyAnomaly', 'ErrorsPage'])
    for (let i = 0; i < 9; i++) {
      await r.tick()
      if (i < 4) expect((await r.status()).anomaly!.status, `tick ${i}`).toBe('warming')
      await runNotifierUntil(notifier, r.tenant, world.now)
    }
    const received = r.w.received
    const tickets = received.filter((x) => x.url.startsWith('https://tickets.test'))
    const pages = received.filter((x) => x.url.startsWith('https://pager.test'))
    expect(tickets).toHaveLength(1)
    expect(pages).toHaveLength(1)
    type Body = { alerts: { status: string; labels: Record<string, string>; annotations: Record<string, string> }[] }
    const t = (tickets[0]!.body as Body).alerts
    expect(t.map((a) => [a.status, a.labels.service, a.labels.severity, a.labels.alertname])).toEqual([['firing', 'b', 'ticket', 'LatencyAnomaly']])
    const p = (pages[0]!.body as Body).alerts
    expect(p.map((a) => [a.labels.severity, a.labels.alertname])).toEqual([['page', 'ErrorsPage']])
    expect(p[0]!.annotations.anomaly).toMatch(/^9 is above the threshold 5 by 80/)

    // The sentence and every number, against the library run independently over the same points.
    const ann = t[0]!.annotations
    const lib = libraryBatch('ewma', { halfLifePoints: 10, minPoints: 5, k: 8, unit: 'ms' }, r.times.slice(0, 9), r.times.slice(0, 9).map((_x, i) => (i === 8 ? 300 : noise(i))))
    const last = lib.points[8]!
    expect(last.anomalous).toBe(true)
    expect(ann.anomaly).toBe(last.explanation!.text)
    expect(ann.anomaly).toMatch(/^300 ms is [\d.]+ standard deviations above the exponentially weighted mean/)
    expect(ann.description, 'no description was written, so the sentence is the description').toBe(last.explanation!.text)
    expect(ann.summary).toBe('b latency is unusual')
    const detail = JSON.parse(ann.anomaly_detail!) as Record<string, unknown>
    expect(detail).toMatchObject({ v: 1, detector: 'ewma', kind: 'deviation', direction: 'above', value: 300, reference: last.explanation!.reference, deviations: last.explanation!.deviations })
    // And the stored detector state equals the library's state after the same points.
    expect(seriesState(await r.rows(), 'b')!.state).toEqual(lib.state)
    const view = await r.status()
    expect(view.anomaly).toMatchObject({ status: 'ok', series: 3, scored: 3, anomalous: 1, stateSeries: 3 })
  })

  it('a NaN point is not scored and keeps the series\' flag (a gap is not a recovery); a series gone longer than the lookback is pruned and counted', async () => {
    const r = await rig([ewmaRule({ keep_firing_for: '0s' }, { params: { halfLifePoints: 10, minPoints: 5, acceptAfter: 50 } })], {
      values: (s, i) => (s === 'b' && i >= 6 ? (i === 7 ? 'NaN' : 400) : noise(i)),
    })
    for (let i = 0; i < 7; i++) await r.tick()
    expect((await r.status()).alerts.map((a) => [a.labels.service, a.state])).toEqual([['b', 'firing']])
    await r.tick() // i = 7: NaN
    const st = (await r.status()).anomaly!
    expect([st.missing, st.anomalous]).toEqual([1, 1])
    expect((await r.status()).alerts.map((a) => [a.labels.service, a.state])).toEqual([['b', 'firing']])
    // Series c disappears; its state stays for the detector's lookback, then goes.
    r.services = ['a', 'b']
    const lookback = r.saved.groups[0]!.rules[0]!.history!.lookbackMs
    for (let i = 0; i < Math.ceil(lookback / MIN) + 2; i++) await r.tick()
    const after = (await r.status()).anomaly!
    expect([after.stateSeries, after.pruned]).toEqual([2, 1])
    expect(seriesState(await r.rows(), 'c')).toBeUndefined()
  })
})

describe('bounds: series cap, state limits, rows per tick', () => {
  it('more series than max_series: the evaluation is refused with a message, nothing is scored, no state row or alert changes; under the cap it resumes', async () => {
    const r = await rig([ewmaRule({}, { max_series: 3 })], { values: (s, i) => (s === 'b' && i >= 6 ? 500 : noise(i)) })
    for (let i = 0; i < 7; i++) await r.tick()
    expect((await r.status()).alerts.map((a) => [a.labels.service, a.state])).toEqual([['b', 'firing']])
    const before = { rows: await r.rows(), alerts: (await r.status()).alerts, handed: r.w.ingestCalls.length }
    r.services = ['a', 'b', 'c', 'd']
    await r.tick()
    const s = await r.status()
    expect(s.health).toBe('err')
    expect(s.lastError).toMatch(/^series_cap_exceeded: the expression returned 4 series; this rule scores at most 3 \(max_series\)/)
    expect(s.anomaly).toMatchObject({ status: 'series_cap_exceeded', series: 4, maxSeries: 3, stateSeries: 3 })
    expect(await r.rows()).toEqual(before.rows)
    expect(s.alerts).toEqual(before.alerts)
    expect(r.w.ingestCalls.length, 'nothing handed to the notifier: the firing alert is not resolved').toBe(before.handed)
    r.services = ['a', 'b', 'c']
    await r.tick()
    expect((await r.status())).toMatchObject({ health: 'ok', anomaly: { status: 'ok', series: 3 } })
  })

  it('max_series above the ruler\'s limit, a state larger than the per-series limit and a rule larger than the per-rule limit are refused when saved', async () => {
    const { tenant, stub } = await setup({ limits: { maxAnomalySeriesPerRule: 50 } })
    const bad = await stub.saveGroups(tenant, { groups: [{ name: 'g', rules: [ewmaRule({}, { max_series: 51 })] }] })
    expect(bad).toMatchObject({ status: 'invalid', errors: [{ path: 'groups[0].rules[0].anomaly.max_series' }] })
    const seasonal = await stub.saveGroups(tenant, { groups: [{ name: 'g', interval: '10s', rules: [{ alert: 'S', expr: LAT, anomaly: { detector: 'seasonal', params: { periodMs: 7 * 24 * 60 * MIN, seasons: 4 } } }] }] })
    expect(seasonal).toMatchObject({ status: 'invalid', errors: [{ path: 'groups[0].rules[0].anomaly.params', message: expect.stringMatching(/bytes of state per series/) }] })
    const perRule = await stub.saveGroups(tenant, { groups: [{ name: 'g', rules: [{ alert: 'Z', expr: LAT, anomaly: { detector: 'robust_z', max_series: 50, params: { windowPoints: 1000 } } }] }] })
    expect(perRule).toMatchObject({ status: 'invalid', errors: [{ path: 'groups[0].rules[0].anomaly.max_series', message: expect.stringMatching(/would exceed the 1048576-byte limit per rule/) }] })
  })

  it('a series whose state outgrows the per-series limit at run time is refused (state_limit_exceeded) and nothing changes', async () => {
    const r = await rig([ewmaRule()], { patch: { limits: { maxAnomalyStateBytesPerSeries: 4096 } } })
    for (let i = 0; i < 3; i++) await r.tick()
    const before = await r.rows()
    const long = 'x'.repeat(5000)
    r.services = ['a', 'b', long]
    await r.tick()
    const s = await r.status()
    expect([s.health, s.anomaly!.status]).toEqual(['err', 'state_limit_exceeded'])
    expect(s.lastError).toMatch(/the limit is 4096. Nothing was scored and no state or alert changed/)
    expect(await r.rows()).toEqual(before)
  })

  it('the anomaly rules of one object may reserve at most maxAnomalyStateBytesPerObject of state, across groups; a replaced group is counted once', async () => {
    const { tenant, stub } = await setup({ limits: { maxAnomalyStateBytesPerObject: 300_000 } })
    // ewma reserves 1,400 bytes a series (estimate): 100 series = 140,000.
    ok(await stub.saveGroups(tenant, { groups: [{ name: 'one', rules: [ewmaRule(), ewmaRule({ alert: 'Second' })] }] }))
    const third = await stub.saveGroups(tenant, { groups: [{ name: 'two', rules: [ewmaRule({ alert: 'Third' })] }] })
    expect(third).toMatchObject({ status: 'invalid', errors: [{ path: 'groups[0].rules[0].anomaly.max_series', message: expect.stringMatching(/would reserve 420000 bytes .* the limit per shard is 300000/) }] })
    ok(await stub.saveGroups(tenant, { groups: [{ name: 'two', rules: [ewmaRule({ alert: 'Third' }, { max_series: 10 })] }] }))
    // Replacing group "one" with the same two rules counts them once, not twice.
    ok(await stub.saveGroups(tenant, { groups: [{ name: 'one', rules: [ewmaRule(), ewmaRule({ alert: 'Second' })] }] }))
  })

  it('state is written as whole batches: one row per rule per tick whatever the series count (never a row per series or per sample); a large state splits into rows of at most 512 KiB', async () => {
    const few = await rig([ewmaRule()], { services: ['a', 'b'] })
    const many = await rig([ewmaRule({}, { max_series: 200 })], { services: Array.from({ length: 200 }, (_, i) => `s${i}`) })
    const perTick: Record<string, number[]> = { few: [], many: [] }
    for (let i = 0; i < 4; i++) {
      for (const [name, r] of [['few', few], ['many', many]] as const) {
        const w0 = ok(await r.stub.health(r.tenant)).counters.sqlRowsWritten
        await r.tick()
        perTick[name]!.push(ok(await r.stub.health(r.tenant)).counters.sqlRowsWritten - w0)
      }
    }
    expect(perTick.few).toEqual(perTick.many)
    expect(Math.max(...perTick.many!)).toBeLessThanOrEqual(3) // the state row, plus the cursor row on a heartbeat
    expect((await many.rows()).map((x) => x.chunk)).toEqual([0])
    // Splitting: rows of at most `rowBytes`, every series in exactly one row, in key order.
    const json = new Map(Array.from({ length: 50 }, (_, i) => [`k${String(i).padStart(2, '0')}`, JSON.stringify({ k: `k${i}`, l: {}, s: 'x'.repeat(100), last: null, seen: 0 })]))
    const rows = stateRows(json, 1024)
    expect(rows.length).toBeGreaterThan(5)
    for (const row of rows) expect(new TextEncoder().encode(row).length).toBeLessThanOrEqual(1024 + 32)
    const back = readStateRows(rows)
    expect('error' in back ? back.error : [...back.series.keys()].length).toBe(50)
    expect(ANOMALY_ROW_BYTES).toBe(512 * 1024)
  })
})

describe('state is rebuilt from SQLite alone', () => {
  it('evicted every few ticks, the stored state, the status and the alerts equal a batch run of the library over the same points', async () => {
    const r = await rig([ewmaRule({}, { params: { halfLifePoints: 10, minPoints: 5, acceptAfter: 50 } })], { values: (s, i) => (s === 'c' && i >= 10 ? 160 + i : noise(i, s === 'a' ? 50 : 100)) })
    for (let i = 0; i < 14; i++) {
      await r.tick()
      if (i % 3 === 1) await evictDurableObject(r.stub)
    }
    const rows = await r.rows()
    for (const s of r.services) {
      const vals = r.times.map((_t, i) => r.values(s, i) as number)
      const lib = libraryBatch('ewma', { halfLifePoints: 10, minPoints: 5, k: 8, acceptAfter: 50, unit: 'ms' }, r.times, vals)
      expect(seriesState(rows, s)!.state, `series ${s}`).toEqual(lib.state)
      expect(seriesState(rows, s)!.last!.flag, `series ${s}`).toBe(lib.points.at(-1)!.anomalous)
    }
    // c was flagged, and its alert is where the library's last flag puts it (EWMA widens its band
    // after clipped anomalies, so a slow climb stops being flagged after a few points).
    const libC = libraryBatch('ewma', { halfLifePoints: 10, minPoints: 5, k: 8, acceptAfter: 50, unit: 'ms' }, r.times, r.times.map((_t, i) => r.values('c', i) as number))
    expect(libC.points.some((p) => p.anomalous)).toBe(true)
    expect((await r.status()).alerts.map((a) => [a.labels.service, a.state])).toEqual([['c', libC.points.at(-1)!.anomalous ? 'firing' : 'inactive']])
    // Memory after an eviction is what SQLite says.
    const live = (await r.status()).anomaly!
    await evictDurableObject(r.stub)
    expect((await r.status()).anomaly).toMatchObject({ stateSeries: live.stateSeries, stateBytes: live.stateBytes })
  })

  it('a tick replayed after an eviction (the heartbeat cursor is behind) re-reads the expression but advances no detector twice', async () => {
    const r = await rig([ewmaRule()])
    for (let i = 0; i < 6; i++) await r.tick()
    const at = world.now
    const before = await r.rows()
    const reported = (await r.status()).anomaly!
    const calls = r.w.evalCalls.length
    await evictDurableObject(r.stub)
    // The same evaluation time again, as an at-least-once alarm would deliver it.
    await runInDurableObject(r.stub, (inst) => inst.alarm())
    expect(world.now).toBe(at)
    expect(r.w.evalCalls.length, 'the replayed tick did evaluate').toBeGreaterThan(calls)
    expect(await r.rows()).toEqual(before)
    // and reports what the first run reported.
    const { status, scored, warming, missing, anomalous, series } = reported
    expect((await r.status()).anomaly).toMatchObject({ status, scored, warming, missing, anomalous, series })
  })

  it('a crash inside the commit transaction persists neither the alerts nor the detector state; the retry gives what a run without the crash gives', async () => {
    const r = await rig([ewmaRule({}, { params: { halfLifePoints: 10, minPoints: 5 } })], { values: (s, i) => (s === 'b' && i === 6 ? 999 : noise(i)) })
    for (let i = 0; i < 6; i++) await r.tick()
    const before = await r.rows()
    r.w.faults.add('ruler:commit')
    world.now = Math.max(world.now, ok(await r.stub.health(r.tenant)).alarmAtMs!)
    const crashed = await runInDurableObject(r.stub, (inst) => inst.alarm()).then(() => 'ok', (e) => (e instanceof Crash || /injected crash/.test(String(e)) ? 'crashed' : String(e)))
    expect(crashed).toBe('crashed')
    expect(await r.rows()).toEqual(before)
    expect((await r.status()).alerts).toEqual([])
    await evictDurableObject(r.stub)
    expect(await runDurableObjectAlarm(r.stub)).toBe(true)
    expect((await r.status()).alerts.map((a) => [a.labels.service, a.state])).toEqual([['b', 'firing']])
    const lib = libraryBatch('ewma', { halfLifePoints: 10, minPoints: 5, k: 8, unit: 'ms' }, r.times, r.times.map((_t, i) => (i === 6 ? 999 : noise(i))))
    expect(seriesState(await r.rows(), 'b')!.state).toEqual(lib.state)
  })

  it('state rows a newer release wrote are refused (state_unreadable): kept unchanged, no alert resolved, and carried by a shard move', async () => {
    const r = await rig([ewmaRule()], { values: (s, i) => (s === 'b' && i >= 6 ? 900 : noise(i)) })
    for (let i = 0; i < 7; i++) await r.tick()
    const key = r.saved.groups[0]!.rules[0]!.key
    const newer = [JSON.stringify({ v: 2, chunks: 'a format from the future' })]
    await runInDurableObject(r.stub, (_i, s) => {
      s.storage.sql.exec('DELETE FROM anomaly_state WHERE tenant = ?', r.tenant)
      s.storage.sql.exec('INSERT INTO anomaly_state (tenant, grp, rule_key, chunk, body) VALUES (?, ?, ?, 0, ?)', r.tenant, 'anomalies/1m', key, newer[0]!)
    })
    await evictDurableObject(r.stub)
    const alerts = (await r.status()).alerts
    const handed = r.w.ingestCalls.length
    await r.tick()
    const s = await r.status()
    expect([s.health, s.anomaly!.status]).toEqual(['err', 'state_unreadable'])
    expect(s.lastError).toMatch(/^state_unreadable: anomaly_state row version 2 is not 1/)
    expect(s.alerts).toEqual(alerts)
    expect(r.w.ingestCalls.length).toBe(handed)
    expect((await r.rows()).map((x) => x.body)).toEqual(newer)
    // A move to another shard carries the rows as they are; the target refuses the rule the same way.
    const bundle = ok(await r.stub.exportGroup(r.tenant, 'anomalies/1m')).bundle
    expect(bundle.anomalyState).toEqual({ [key]: newer })
    const target = rulerStub(r.tenant, '1')
    ok(await target.configure(r.tenant, { deadman: false, heartbeatMs: 30 * MIN }))
    ok(await target.importGroup(r.tenant, bundle))
    const moved = await runInDurableObject(target, (_i, st) => st.storage.sql.exec('SELECT body FROM anomaly_state WHERE tenant = ?', r.tenant).toArray())
    expect(moved.map((x) => x.body)).toEqual(newer)
    expect(ok(await target.rules(r.tenant)).rules[0]!.anomaly!.status).toBe('state_unreadable')
  })

  it('every statement on detector state names the tenant: a row of another tenant in the same storage is neither loaded nor touched', async () => {
    const r = await rig([ewmaRule()])
    for (let i = 0; i < 3; i++) await r.tick()
    const key = r.saved.groups[0]!.rules[0]!.key
    const mine = await r.rows()
    // The other tenant's row: the same group, rule key and chunk, holding a series of its own.
    const body = (mine[0]!.body as string).replaceAll(fingerprint({ service: 'a' }), fingerprint({ service: 'zz' })).replace(/"service":"a"/g, '"service":"zz"')
    const foreign = { tenant: 'someone-else', grp: 'anomalies/1m', rule_key: key, chunk: 0, body }
    await runInDurableObject(r.stub, (_i, s) => void s.storage.sql.exec('INSERT INTO anomaly_state (tenant, grp, rule_key, chunk, body) VALUES (?, ?, ?, ?, ?)', foreign.tenant, foreign.grp, foreign.rule_key, foreign.chunk, foreign.body))
    await evictDurableObject(r.stub)
    expect((await r.status()).anomaly!.stateSeries, 'loaded: this tenant\'s three series only').toBe(3)
    await r.tick()
    expect(seriesState((await r.rows()).filter((x) => x.tenant === r.tenant), 'zz')).toBeUndefined()
    expect((await r.rows()).find((x) => x.tenant === 'someone-else')).toEqual(foreign)
    ok(await r.stub.deleteGroup(r.tenant, 'anomalies/1m'))
    expect(await r.rows()).toEqual([foreign])
  })
})

describe('rules over time: edits, intervals, rule files', () => {
  it('an edit that keeps the detector and parameters keeps the state; a new parameter or interval is a new rule with fresh state', async () => {
    const r = await rig([ewmaRule()])
    for (let i = 0; i < 6; i++) await r.tick()
    const key = r.saved.groups[0]!.rules[0]!.key
    const resaved = ok(await r.stub.saveGroups(r.tenant, { groups: [{ name: 'anomalies/1m', interval: '1m', rules: [ewmaRule({ annotations: { runbook_url: 'https://runbooks.test/latency' } })] }] }))
    expect(resaved.groups[0]!.rules[0]!.key).toBe(key)
    expect((await r.rows()).map((x) => x.rule_key)).toEqual([key])
    const changed = ok(await r.stub.saveGroups(r.tenant, { groups: [{ name: 'anomalies/1m', interval: '1m', rules: [ewmaRule({}, { params: { halfLifePoints: 20, minPoints: 5 } })] }] }))
    expect(changed.groups[0]!.rules[0]!.key).not.toBe(key)
    expect(await r.rows()).toEqual([])
    await r.tick()
    expect((await r.status()).anomaly!.stateSeries).toBe(3)
    ok(await r.stub.saveGroups(r.tenant, { groups: [{ name: 'anomalies/1m', interval: '2m', rules: [ewmaRule({}, { params: { halfLifePoints: 20, minPoints: 5 } })] }] }))
    expect(await r.rows(), 'the detector\'s step is the interval: other interval, other state').toEqual([])
  })

  it('a rule file round-trips with every parameter written out; the Prometheus export leaves anomaly rules out and says so', async () => {
    const r = await rig([ewmaRule(), { alert: 'Cpu', expr: 'cpu', anomaly: { detector: 'cusum' } }, { alert: 'Plain', expr: 'up == 0' }])
    const groups = ok(await r.stub.listGroups(r.tenant)).groups
    const extended = exportRuleFile(groups, { extensions: true })
    const imported = importRuleFile(extended.yaml)
    if (!imported.ok) throw new Error(JSON.stringify(imported))
    const again = ok(await r.stub.saveGroups(r.tenant, imported.file))
    expect(again.groups[0]!.rules.map((x) => [x.name, x.kind, x.key])).toEqual(r.saved.groups[0]!.rules.map((x) => [x.name, x.kind, x.key]))
    const plain = exportRuleFile(groups, { extensions: false })
    expect(plain.yaml).not.toMatch(/LatencyAnomaly|anomaly:/)
    expect(plain.yaml).toMatch(/alert: Plain/)
    expect(plain.dropped).toEqual(expect.arrayContaining(['anomalies/1m/LatencyAnomaly: anomaly rule (ewma)', 'anomalies/1m/Cpu: anomaly rule (cusum)']))
    // cusum explains, it does not page: its default severity is info.
    expect(ok(await r.stub.rules(r.tenant)).rules.find((x) => x.name === 'Cpu')).toBeDefined()
    const cpu = groups[0]!.anomalyRules!.find((x) => x.name === 'Cpu')!
    expect([cpu.anomaly.severity, cpu.labels.severity]).toEqual(['info', 'info'])
  })

  it('/api/v1/rules shows an anomaly rule as an alerting rule with exactly Prometheus\' fields', async () => {
    const r = await rig([ewmaRule(), { alert: 'Plain', expr: 'up == 0' }])
    await r.tick()
    const key = await apiKey(r.tenant)
    const res = await call(key.auth, 'GET', '/api/v1/rules')
    const rules = (res.json.data.groups[0].rules as Record<string, unknown>[])
    const anomaly = rules.find((x) => x.name === 'LatencyAnomaly')!
    const plain = rules.find((x) => x.name === 'Plain')!
    expect(Object.keys(anomaly).sort()).toEqual(Object.keys(plain).sort())
    expect([anomaly.type, anomaly.query]).toEqual(['alerting', LAT])
  })
})

describe('the monitors API', () => {
  async function scene() {
    world.now = T0
    const tenant = newTenant('anm')
    const key = await apiKey(tenant)
    ok(await rulerStub(tenant).configure(tenant, { deadman: false, heartbeatMs: 30 * MIN }))
    const w = tenantWorld(tenant)
    w.evaluate = (q) => (q === LAT ? vec([{ service: 'a' }, 100], [{ service: 'b' }, 101]) : vec())
    return { tenant, key, w }
  }

  it('an anomaly monitor is query + anomaly; its defaults are the held-out ones (ewma, half-life 100, k 8; ticket; for 0s, keep firing 10m) and it starts out warming', async () => {
    const { tenant, key } = await scene()
    const res = await call(key.auth, 'POST', '/api/v1/monitors', { name: 'checkout latency', query: LAT, anomaly: {} })
    expect(res.status).toBe(201)
    expect(res.json).toMatchObject({ group: 'anomalies/1m', cost: { class: 'tail' }, history: { tick: 'tail', coldStart: expect.any(String), minPoints: 30 }, warnings: [] })
    const ruler = rulerStub(tenant)
    world.now = Math.max(world.now, ok(await ruler.health(tenant)).alarmAtMs!)
    expect(await runDurableObjectAlarm(ruler)).toBe(true)
    const m = (await call(key.auth, 'GET', `/api/v1/monitors/${res.json.id}`)).json.monitor as MonitorView
    expect(m).toMatchObject({ state: 'warming', query: LAT, condition: null, forMs: 0, keepFiringForMs: 10 * MIN, labels: { severity: 'ticket' } })
    expect(m.anomaly).toMatchObject({ detector: 'ewma', given: [], severity: 'ticket', maxSeries: 100, params: { halfLifePoints: 100, k: 8 }, status: { status: 'warming', series: 2 } })
    expect(m.anomaly!.status!.message).toMatch(/^2 of 2 series warming: /)
    expect(m.anomaly!.guide.evidence).toMatchObject({ kind: 'held_out', defaultsValidated: true, nab: { standard: 30.1 } })
    expect(m.thresholdText).toBe('ewma: 8 σ from a 100-point mean')
    const list = (await call(key.auth, 'GET', '/api/v1/monitors')).json
    expect(list.counts.warming).toBe(1)
  })

  it('problems come back in the monitor\'s own field names, with a fix that states the evidence', async () => {
    const { key } = await scene()
    const post = (body: Record<string, unknown>) => call(key.auth, 'POST', '/api/v1/monitors', { name: 'x', query: LAT, ...body })
    const stl = await post({ anomaly: { detector: 'stl' } })
    expect(stl.status).toBe(422)
    expect(stl.json.problems).toMatchObject([{ path: 'anomaly.detector', message: expect.stringMatching(/cannot run in a monitor: Alarms: its residuals scored -352.2/) }])
    const cusumPage = await post({ anomaly: { detector: 'cusum', severity: 'page' } })
    expect(cusumPage.json.problems).toMatchObject([{ path: 'anomaly.severity', message: expect.stringMatching(/cusum may not page/) }])
    const pageNoLevel = await post({ anomaly: { severity: 'page' } })
    expect(pageNoLevel.json.problems).toMatchObject([{ path: 'anomaly.params', fix: expect.stringMatching(/static threshold.*beat EWMA when false alarms cost most/) }])
    const both = await post({ anomaly: {}, condition: { op: '>', threshold: 1 } })
    expect(both.json.problems).toMatchObject([{ path: 'condition' }])
    const tooMany = await post({ anomaly: { maxSeries: 5000 } })
    expect(tooMany.json.problems).toMatchObject([{ path: 'anomaly.maxSeries', message: expect.stringMatching(/above this ruler's limit of 1000/) }])
    const unknown = await post({ anomaly: { params: { window: 5 } } })
    expect(unknown.json.problems).toMatchObject([{ path: 'anomaly.params.window', message: 'ewma has no parameter "window"' }])
    const madWarn = await post({ anomaly: { detector: 'robust_z', maxSeries: 10 }, dryRun: true })
    expect(madWarn.status).toBe(200)
    expect(madWarn.json.warnings).toMatchObject([{ path: 'anomaly.detector', message: expect.stringMatching(/scored below a static threshold on held-out NAB \(-105.9 vs 21.8\)/) }])
    const quantile = await post({ anomaly: { detector: 'robust_z', maxSeries: 10, params: { spread: 'quantile' } }, dryRun: true })
    // Not given, max_series is what fits the per-rule state limit, and the save says so.
    const fitted = await post({ anomaly: { detector: 'cusum' }, dryRun: true })
    expect(fitted.status).toBe(200)
    expect(fitted.json.warnings).toMatchObject([
      { path: 'anomaly.maxSeries', message: expect.stringMatching(/^max_series defaults to 49 here, not 100: cusum/) },
      { path: 'anomaly.detector', message: expect.stringMatching(/cusum as configured scored below a static threshold on held-out NAB \(15.1 vs 21.8\)/) },
    ])
    expect(quantile.json.warnings).toMatchObject([{ path: 'anomaly.params.spread', message: expect.stringMatching(/not validated: it was chosen after seeing the NAB results/) }])
  })

  it('GET /monitors/detectors: ewma is the default and the only one with validated defaults; threshold for pages; STL, CUSUM and PELT explain and do not page; nothing post hoc is presented as validated', async () => {
    const { key } = await scene()
    const d = (await call(key.auth, 'GET', '/api/v1/monitors/detectors')).json
    expect([d.default, d.defaultForPage]).toEqual(['ewma', 'threshold'])
    const by = Object.fromEntries((d.detectors as { name: string }[]).map((x) => [x.name, x])) as unknown as Record<string, { inRules: boolean; pageAllowed: boolean; notFor: string; goodFor: string; evidence: { defaultsValidated: boolean; nab: { standard: number } | null; note: string } }>
    expect(Object.entries(by).filter(([, g]) => g.evidence.defaultsValidated).map(([n]) => n)).toEqual(['ewma'])
    for (const n of ['stl', 'pelt', 'cusum']) {
      expect(by[n]!.pageAllowed, n).toBe(false)
      expect(`${by[n]!.goodFor} ${by[n]!.notFor} ${by[n]!.evidence.note}`, n).toMatch(/explanation/i)
    }
    expect([by.stl!.inRules, by.pelt!.inRules, by.cusum!.inRules]).toEqual([false, false, true])
    for (const n of ['robust_z', 'seasonal']) {
      expect(by[n]!.evidence.nab!.standard, n).toBeLessThan(by.threshold!.evidence.nab!.standard)
      expect(by[n]!.evidence.note, n).toMatch(/after seeing these results|post hoc/)
      expect(by[n]!.evidence.note, n).toMatch(/not a default/)
    }
    expect(by.ewma!.evidence.nab!.standard).toBeGreaterThan(by.threshold!.evidence.nab!.standard)
  })

  it('authorisation: creating, editing and deleting an anomaly monitor needs monitors:write; reading it and the detectors needs monitors:read', async () => {
    const { tenant, key } = await scene()
    const id = (await call(key.auth, 'POST', '/api/v1/monitors', { name: 'm', query: LAT, anomaly: {} })).json.id as string
    const read = await apiKey(tenant, ['monitors:read'])
    const ack = await apiKey(tenant, ['monitors:ack'])
    expect((await call(read.auth, 'POST', '/api/v1/monitors', { name: 'n', query: LAT, anomaly: {} })).status).toBe(403)
    expect((await call(read.auth, 'PUT', `/api/v1/monitors/${id}`, { name: 'm', query: LAT, anomaly: { detector: 'cusum' } })).status).toBe(403)
    expect((await call(read.auth, 'DELETE', `/api/v1/monitors/${id}`)).status).toBe(403)
    expect((await call(read.auth, 'GET', `/api/v1/monitors/${id}`)).status).toBe(200)
    expect((await call(read.auth, 'GET', '/api/v1/monitors/detectors')).status).toBe(200)
    expect((await call(ack.auth, 'GET', '/api/v1/monitors/detectors')).status).toBe(403)
    expect((await call(null, 'GET', '/api/v1/monitors/detectors')).status).toBe(401)
    expect((await call(key.auth, 'GET', `/api/v1/monitors/${id}`)).json.monitor.anomaly.detector).toBe('ewma')
  })

  it('tenant isolation: the tenant is the credential\'s; another tenant\'s key, whatever it names in paths, queries, headers or bodies, never sees or changes an anomaly monitor or its state', async () => {
    const a = await scene()
    const b = await scene()
    const id = (await call(a.key.auth, 'POST', '/api/v1/monitors', { name: 'a latency', query: LAT, anomaly: {} })).json.id as string
    const aRuler = rulerStub(a.tenant)
    for (let i = 0; i < 2; i++) {
      world.now = Math.max(world.now, ok(await aRuler.health(a.tenant)).alarmAtMs!)
      expect(await runDurableObjectAlarm(aRuler)).toBe(true)
    }
    const state = async () => ({
      rows: await runInDurableObject(aRuler, (_i, s) => s.storage.sql.exec('SELECT * FROM anomaly_state').toArray()),
      monitor: (await call(a.key.auth, 'GET', `/api/v1/monitors/${id}`)).json.monitor.anomaly,
    })
    const before = await state()
    expect(before.rows.length).toBe(1)
    const sneaky: Record<string, string>[] = [{}, { 'X-Scope-OrgID': a.tenant }, { 'X-Tenant': a.tenant }]
    for (const h of sneaky) {
      for (const q of ['', `?tenant=${a.tenant}`, `?orgId=${a.tenant}`]) {
        const list = await call(b.key.auth, 'GET', `/api/v1/monitors${q}`, undefined, h)
        expect(list.status).toBe(200)
        expect(list.json.total, JSON.stringify({ h, q })).toBe(0)
        expect((await call(b.key.auth, 'GET', `/api/v1/monitors/${id}${q}`, undefined, h)).status).toBe(404)
        expect((await call(b.key.auth, 'PUT', `/api/v1/monitors/${id}${q}`, { name: 'x', query: LAT, anomaly: { detector: 'cusum' }, tenant: a.tenant }, h)).status).toBe(404)
        expect((await call(b.key.auth, 'DELETE', `/api/v1/monitors/${id}${q}`, undefined, h)).status).toBe(404)
        const groups = await call(b.key.auth, 'GET', `/api/v1/monitors/groups${q}`, undefined, h)
        expect(groups.text).not.toContain('a latency')
        const created = await call(b.key.auth, 'POST', `/api/v1/monitors${q}`, { name: 'b probe', query: LAT, anomaly: {}, group: 'anomalies/1m', dryRun: true }, h)
        expect(created.status).toBe(200)
        const named = await call(b.key.auth, 'POST', `/api/v1/monitors${q}`, { name: 'b probe', query: LAT, anomaly: {}, dryRun: true, tenant: a.tenant }, h)
        expect([named.status, named.json.problems]).toMatchObject([422, [{ path: 'tenant', message: 'unknown field "tenant"' }]])
      }
    }
    expect(await state()).toEqual(before)
    expect(await runInDurableObject(rulerStub(b.tenant), (_i, s) => s.storage.sql.exec('SELECT COUNT(*) AS n FROM anomaly_state').one().n)).toBe(0)
    // The object itself refuses a foreign tenant on every call that reaches anomaly state.
    for (const res of [await aRuler.rules(b.tenant), await aRuler.snapshot(b.tenant), await aRuler.exportGroup(b.tenant, 'anomalies/1m'), await aRuler.deleteGroup(b.tenant, 'anomalies/1m'), await aRuler.removeRule(b.tenant, 'anomalies/1m', id)]) {
      expect(res).toEqual({ status: 'wrong_tenant' })
    }
    expect(await state()).toEqual(before)
  })

  it('the documented schemas list every field an anomaly monitor, its status and the detectors return, and the handlers return every required one', async () => {
    const { tenant, key } = await scene()
    const res = await call(key.auth, 'POST', '/api/v1/monitors', { name: 'm', query: LAT, anomaly: { detector: 'ewma', maxSeries: 10 } })
    const ruler = rulerStub(tenant)
    world.now = Math.max(world.now, ok(await ruler.health(tenant)).alarmAtMs!)
    expect(await runDurableObjectAlarm(ruler)).toBe(true)
    const schemas = spec.components.schemas as unknown as Record<string, { required?: string[]; properties: Record<string, unknown> }>
    const agree = (name: string, obj: object) => {
      const s = schemas[name]!
      for (const k of Object.keys(obj)) expect(Object.keys(s.properties), `${name}.${k} is returned but not documented`).toContain(k)
      for (const k of s.required ?? []) expect(Object.keys(obj), `${name}.${k} is documented as required but not returned`).toContain(k)
    }
    agree('MonitorSaved', res.json)
    agree('AnomalyHistory', res.json.history)
    const m = (await call(key.auth, 'GET', `/api/v1/monitors/${res.json.id}`)).json.monitor as MonitorView
    agree('Monitor', m)
    agree('MonitorAnomaly', m.anomaly!)
    agree('AnomalyStatus', m.anomaly!.status as AnomalyRuleStatus)
    agree('DetectorGuide', m.anomaly!.guide)
    expect((schemas.Monitor!.properties.state as { enum: string[] }).enum).toContain(m.state)
    const d = (await call(key.auth, 'GET', '/api/v1/monitors/detectors')).json
    agree('Detectors', d)
    for (const g of d.detectors) agree('DetectorGuide', g)
    const statuses = (schemas.AnomalyStatus!.properties.status as { enum: string[] }).enum
    expect(statuses.sort()).toEqual(['ok', 'series_cap_exceeded', 'state_limit_exceeded', 'state_unreadable', 'unknown', 'warming'])
  })
})
