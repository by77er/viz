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
import type { AnomalyRuleStatus, AnomalyRuleV2, DetectorGuide, MonitorView, RuleGroup } from '../contracts-proposal/rules.v2'
import spec from '../openapi.json'
import { ANOMALY_ROW_BYTES, anomalyLimits, DEFAULT_DETECTOR, estimateStateBytes, evalAnomaly, newAnomalyRt, PREVIOUS_DEFAULTS, readAnomalyRows, readStateRows, ROBUST_Z_DEFAULTS, SEASONAL_DEFAULTS, stateRows } from '../src/anomaly'
import { DEFAULT_RULER_CONFIG } from '../src/ruler'
import { parseRuleFile } from '../src/rules'
import { exportRuleFile, importRuleFile } from '../src/rulefile'
import before20261119 from './fixtures/anomaly/before-2026-11-19.json'
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
  anomaly: { detector: 'ewma', params: { halfLifePoints: 10, minPoints: 5 }, unit: 'ms', ...anomaly },
})

/** The stored state of one series, decoded (rows of one rule, `store.anomaly-state` version 1 or 2). */
function seriesState(rows: Record<string, unknown>[], service: string) {
  const read = readAnomalyRows(rows.map((r) => ({ chunk: r.chunk as number, body: r.body as string })))
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
    const newer = [JSON.stringify({ v: 3, chunks: 'a format from the future' })]
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
    expect(s.lastError).toMatch(/^state_unreadable: anomaly_state row version 3 is not 1 or 2/)
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

  it('a stored rule naming a detector this release does not know (a newer release saved it) is refused, not run as another detector; its state and alerts stay', async () => {
    const r = await rig([ewmaRule()])
    for (let i = 0; i < 6; i++) await r.tick()
    await runInDurableObject(r.stub, (_i, s) => {
      const spec = JSON.parse(s.storage.sql.exec('SELECT spec FROM rule_group WHERE tenant = ?', r.tenant).one().spec as string)
      spec.anomalyRules[0].anomaly.detector = 'mstl'
      s.storage.sql.exec('UPDATE rule_group SET spec = ? WHERE tenant = ?', JSON.stringify(spec), r.tenant)
    })
    await evictDurableObject(r.stub)
    const before = await r.rows()
    await r.tick()
    const s = await r.status()
    expect([s.health, s.lastError]).toEqual(['err', expect.stringMatching(/^unsupported_detector: this release does not know the detector "mstl"/)])
    expect(await r.rows()).toEqual(before)
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

  it('an anomaly monitor is query + anomaly; its defaults follow the evidence (D33: robust z with the quantile spread, window 1,500, k 2; ticket; for 0s, keep firing 10m; max_series what fits) and it starts out warming', async () => {
    const { tenant, key } = await scene()
    const res = await call(key.auth, 'POST', '/api/v1/monitors', { name: 'checkout latency', query: LAT, anomaly: {} })
    expect(res.status).toBe(201)
    expect(res.json).toMatchObject({ group: 'anomalies/1m', cost: { class: 'tail' }, history: { tick: 'tail', coldStart: 'rollup', minPoints: 20, lookbackMs: 1500 * MIN } })
    // About 55 KB of state a series as JSON (what this release writes): 18 series fit the 1 MiB a rule may keep, and the save says so.
    // (The release that writes ring blocks: about 18.8 KB, 55 series; anomalystore.test.ts.)
    expect(res.json.warnings).toEqual([{ path: 'anomaly.maxSeries', message: expect.stringMatching(/^max_series defaults to 18 here, not 100: robust_z with these parameters may keep about 55400 bytes/), fix: expect.any(String) }])
    const ruler = rulerStub(tenant)
    world.now = Math.max(world.now, ok(await ruler.health(tenant)).alarmAtMs!)
    expect(await runDurableObjectAlarm(ruler)).toBe(true)
    const m = (await call(key.auth, 'GET', `/api/v1/monitors/${res.json.id}`)).json.monitor as MonitorView
    expect(m).toMatchObject({ state: 'warming', query: LAT, condition: null, forMs: 0, keepFiringForMs: 10 * MIN, labels: { severity: 'ticket' } })
    expect(m.anomaly).toMatchObject({ detector: 'robust_z', given: [], severity: 'ticket', maxSeries: 18, params: { windowPoints: 1500, k: 2, spread: 'quantile', spreadQuantile: 0.99, windowMs: 0, minPoints: 20 }, status: { status: 'warming', series: 2 } })
    expect(m.anomaly!.status!.message).toMatch(/^2 of 2 series warming: /)
    expect(m.anomaly!.guide.evidence).toMatchObject({ kind: 'held_out', defaultsValidated: true, nab: { standard: 42.6 } })
    expect(m.thresholdText).toBe('robust_z: 2 × the 0.99 quantile deviation from the trailing median')
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
    expect(pageNoLevel.json.problems).toMatchObject([{ path: 'anomaly.params', fix: expect.stringMatching(/static threshold, because it held up best where false alarms cost most \(low-FP profile: NAB held out 5.5 vs EWMA 3.9; SMD 15.5 vs EWMA -38.4\)/) }])
    const both = await post({ anomaly: {}, condition: { op: '>', threshold: 1 } })
    expect(both.json.problems).toMatchObject([{ path: 'condition' }])
    const tooMany = await post({ anomaly: { maxSeries: 5000 } })
    expect(tooMany.json.problems).toMatchObject([{ path: 'anomaly.maxSeries', message: expect.stringMatching(/above this ruler's limit of 1000/) }])
    const unknown = await post({ anomaly: { params: { window: 5 } } })
    expect(unknown.json.problems).toMatchObject([{ path: 'anomaly.params.window', message: 'robust_z has no parameter "window"' }])
    const madWarn = await post({ anomaly: { detector: 'robust_z', maxSeries: 10, params: { spread: 'mad' } }, dryRun: true })
    expect(madWarn.status).toBe(200)
    expect(madWarn.json.warnings).toMatchObject([{ path: 'anomaly.params.spread', message: expect.stringMatching(/robust_z with the MAD spread scored below a static threshold on held-out NAB \(-105.9 vs 21.8\) and on SMD \(-318.2 vs 16.4\)/) }])
    const ewmaWarn = await post({ anomaly: { detector: 'ewma' }, dryRun: true })
    expect(ewmaWarn.json.warnings).toMatchObject([{ path: 'anomaly.detector', message: expect.stringMatching(/on SMD, data never used to choose it, ewma scored below a static threshold in every profile \(10.4 vs 16.4; held-out NAB 30.1 vs 21.8\)/) }])
    // A backtest of an anomaly monitor runs its detector over history (test/history.test.ts); with no
    // history to read it fails explicitly, it does not answer an empty result.
    const bt = await call(key.auth, 'POST', '/api/v1/monitors/backtest', { monitor: { name: 'x', query: LAT, anomaly: {} }, fromMs: T0, toMs: T0 + 10 * MIN, step: '1m' })
    expect([bt.status, bt.json.error.code]).toEqual([502, 'evaluation_failed'])
    const quantile = await post({ anomaly: { detector: 'robust_z', maxSeries: 10, params: { spread: 'quantile' } }, dryRun: true })
    const pageZ = await post({ anomaly: { detector: 'robust_z', maxSeries: 10, severity: 'page' }, dryRun: true })
    expect(pageZ.json.warnings).toMatchObject([{ path: 'anomaly.severity', message: expect.stringMatching(/lead over a static threshold in the low-false-positive profile is not significant/) }])
    // Not given, max_series is what fits the per-rule state limit, and the save says so.
    const fitted = await post({ anomaly: { detector: 'cusum' }, dryRun: true })
    expect(fitted.status).toBe(200)
    expect(fitted.json.warnings).toMatchObject([
      { path: 'anomaly.maxSeries', message: expect.stringMatching(/^max_series defaults to 49 here, not 100: cusum/) },
      { path: 'anomaly.detector', message: expect.stringMatching(/cusum scored below a static threshold on held-out NAB \(15.1 vs 21.8\) and on SMD \(-147.6 vs 16.4\)/) },
    ])
    // The quantile spread was confirmed on data it had not seen (SMD): no longer warned as unvalidated.
    expect(quantile.json.warnings).toEqual([])
  })

  it('GET /monitors/detectors: robust z with the quantile spread is the default, threshold for pages; every number carries its kind of evidence, and the default window\'s SMD score is post hoc; STL, CUSUM and PELT explain and do not page', async () => {
    const { key } = await scene()
    const d = (await call(key.auth, 'GET', '/api/v1/monitors/detectors')).json
    expect([d.default, d.defaultForPage]).toEqual(['robust_z', 'threshold'])
    const by = Object.fromEntries((d.detectors as DetectorGuide[]).map((x) => [x.name, x])) as Record<string, DetectorGuide>
    // Validated: scored on data the defaults were not chosen on (held out on NAB, or frozen and scored on SMD).
    expect(Object.entries(by).filter(([, g]) => g.evidence.defaultsValidated).map(([n]) => n)).toEqual(['robust_z', 'ewma', 'seasonal'])
    for (const g of Object.values(by)) {
      expect(g.evidence.lines!.length, g.name).toBeGreaterThan(0)
      for (const l of g.evidence.lines!) {
        expect(['held_out', 'confirmed', 'not_confirmed', 'post_hoc', 'not_scorable'], `${g.name}: ${l.config}`).toContain(l.kind)
        // SMD was never used to choose anything: a line on it is a confirmation (or not), or post hoc; never "held out".
        if (l.data === 'SMD') expect(['confirmed', 'not_confirmed', 'post_hoc'], `${g.name}: ${l.config}`).toContain(l.kind)
      }
    }
    // The default: its window was set by the state limit; NAB held out; SMD post hoc (only 4,000 was pre-registered, and that one is confirmed).
    expect(by.robust_z!.defaults).toEqual({ ...ROBUST_Z_DEFAULTS })
    const z = (data: string, config: string) => by.robust_z!.evidence.lines!.find((l) => l.data === data && l.config.startsWith(config))!
    expect(z('NAB', 'quantile spread, window 1,500')).toMatchObject({ kind: 'held_out', score: { standard: 42.6, lowFp: 29.7, lowFn: 55.4 } })
    expect(z('SMD', 'quantile spread, window 1,500')).toMatchObject({ kind: 'post_hoc', score: { standard: 42.5, lowFp: 21.2, lowFn: 50.8 } })
    expect(z('SMD', 'quantile spread, window 4,000')).toMatchObject({ kind: 'confirmed', score: { standard: 42.8 } })
    expect(z('NAB', 'quantile spread, window and k chosen')).toMatchObject({ kind: 'post_hoc', score: { standard: 44.8 } })
    // It beats EWMA and the static threshold on both benchmarks, which is what made it the default.
    const std = (n: string, data: string) => by[n]!.evidence.lines!.find((l) => l.data === data)!.score!.standard
    for (const data of ['NAB', 'SMD']) {
      expect(z(data, 'quantile spread, window 1,500').score!.standard, data).toBeGreaterThan(Math.max(std('ewma', data), std('threshold', data)))
    }
    // EWMA, the default until 2026-11-19, did not hold on SMD, and says so.
    expect(by.ewma!.evidence.lines!.find((l) => l.data === 'SMD')).toMatchObject({ kind: 'not_confirmed', score: { standard: 10.4 } })
    expect(by.ewma!.notFor).toMatch(/A default, and paging/)
    expect(by.seasonal!.defaults).toEqual({ ...SEASONAL_DEFAULTS })
    // Literally: a change to the constants above must show here.
    expect(by.robust_z!.defaults).toEqual({ windowPoints: 1500, k: 2, spread: 'quantile', spreadQuantile: 0.99 })
    expect(by.seasonal!.defaults).toEqual({ seasons: 1, k: 2, adapt: 'robust', spread: 'quantile', spreadQuantile: 0.99 })
    expect(by.seasonal!.evidence.lines!.find((l) => l.data === 'SMD' && l.config.startsWith('quantile'))).toMatchObject({ kind: 'confirmed', score: { standard: 35.5 } })
    for (const n of ['stl', 'pelt', 'cusum']) {
      expect(by[n]!.pageAllowed, n).toBe(false)
      expect(`${by[n]!.goodFor} ${by[n]!.notFor} ${by[n]!.evidence.note}`, n).toMatch(/explanation/i)
    }
    expect([by.stl!.inRules, by.pelt!.inRules, by.cusum!.inRules]).toEqual([false, false, true])
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
    expect((await call(key.auth, 'GET', `/api/v1/monitors/${id}`)).json.monitor.anomaly.detector).toBe('robust_z')
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
    // One version 1 row; the head and a block where the gate writes version 2.
    expect(before.rows.length).toBeGreaterThan(0)
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

describe('defaults across an upgrade (D33 replaced on 2026-11-19: robust z with the quantile spread instead of EWMA)', () => {
  /** The rules the release before the change stored (test/fixtures/anomaly), and their keys. */
  const OLD = JSON.parse(before20261119.stored) as RuleGroup
  const OLD_RULES = OLD.anomalyRules as AnomalyRuleV2[]
  const oldRule = (name: string) => OLD_RULES.find((r) => r.name === name)!
  const spike = (s: string, i: number) => (s === 'b' && i === 22 ? 130 : noise(i))

  /** A tenant whose storage holds the group exactly as the release before the change left it; evicted, so the constructor reads it. */
  async function upgraded() {
    const r = await rig([ewmaRule()], { values: spike })
    await runInDurableObject(r.stub, (_i, s) => {
      s.storage.sql.exec('UPDATE rule_group SET spec = ? WHERE tenant = ? AND name = ?', before20261119.stored, r.tenant, 'anomalies/1m')
      // Its warm-ups finished long ago (or it predates them): none pending, no state yet.
      s.storage.sql.exec('DELETE FROM warmup WHERE tenant = ?', r.tenant)
      s.storage.sql.exec('DELETE FROM anomaly_state WHERE tenant = ?', r.tenant)
    })
    await evictDurableObject(r.stub)
    return r
  }
  const storedRules = async (r: Awaited<ReturnType<typeof upgraded>>) => ok(await r.stub.listGroups(r.tenant)).groups.find((g) => g.name === 'anomalies/1m')!.anomalyRules!

  it('a rule stored without a detector before the change still evaluates as EWMA after the upgrade, and robust z and seasonal stored without a spread still run the MAD: state and scores equal a batch run of the library with the stored parameters', async () => {
    const r = await upgraded()
    expect((await storedRules(r)).map((x) => [x.name, x.key, x.anomaly.detector, x.anomaly.params])).toEqual(OLD_RULES.map((x) => [x.name, x.key, x.anomaly.detector, x.anomaly.params]))
    expect(oldRule('LatencyAnomaly').anomaly).toMatchObject({ detector: 'ewma', given: [], params: { halfLifePoints: 100, k: 8 } })
    for (let i = 0; i < 24; i++) await r.tick()
    const rows = await r.rows()
    for (const old of OLD_RULES) {
      const own = rows.filter((x) => x.rule_key === old.key)
      expect(own.length, old.name).toBeGreaterThan(0)
      for (const svc of r.services) {
        const vals = r.times.map((_t, i) => r.values(svc, i) as number)
        const lib = libraryBatch(old.anomaly.detector as keyof typeof DETECTORS, { ...old.anomaly.params, unit: old.anomaly.unit }, r.times, vals)
        const got = seriesState(own, svc)!
        expect(got.state, `${old.name} ${svc}`).toEqual(lib.state)
        const last = lib.points.at(-1) as unknown as { status: string; anomalous: boolean; score: number }
        expect([got.last!.status, got.last!.flag, got.last!.score], `${old.name} ${svc}`).toEqual([last.status === 'warming' ? 'warming' : 'ok', last.anomalous, last.score])
      }
    }
    // The robust z rule scored (minPoints 20), with the MAD spread it was stored with.
    expect(seriesState(rows.filter((x) => x.rule_key === oldRule('LatencyRobust').key), 'b')!.last!.status).toBe('ok')
    // A rule saved now, leaving the detector out, gets the new default.
    const fresh = ok(await r.stub.saveGroups(r.tenant, { groups: [{ name: 'new', interval: '1m', rules: [{ alert: 'Fresh', expr: LAT, anomaly: {} }] }] }))
    const freshRule = ok(await r.stub.listGroups(r.tenant)).groups.find((g) => g.name === 'new')!.anomalyRules![0]!
    expect(fresh.groups[0]!.rules[0]!.kind).toBe('anomaly')
    expect([freshRule.anomaly.detector, freshRule.anomaly.params.spread, freshRule.anomaly.params.windowPoints, freshRule.anomaly.params.k]).toEqual([DEFAULT_DETECTOR, 'quantile', 1500, 2])
  })

  it('saved again unchanged, a stored rule keeps the defaults it was stored with (its key and state too), and the save says so; naming the detector or a parameter changes it, and a new rule gets today\'s defaults', async () => {
    const r = await upgraded()
    for (let i = 0; i < 3; i++) await r.tick()
    const keys = new Set((await r.rows()).map((x) => x.rule_key))
    expect(keys).toEqual(new Set(OLD_RULES.map((x) => x.key)))
    // The very document the author saved before the change.
    const again = ok(await r.stub.saveGroups(r.tenant, before20261119.input))
    expect(again.groups[0]!.rules.map((x) => x.key)).toEqual(OLD_RULES.map((x) => x.key))
    // Everything stored is kept but the size estimate, which follows the stored form the gate writes
    // (the same as stored while it writes JSON; smaller for robust z and seasonal as ring blocks).
    const noSize = ({ stateBytesPerSeries: _s, ...a }: AnomalyRuleV2['anomaly']) => a
    expect((await storedRules(r)).map((x) => noSize(x.anomaly))).toEqual(OLD_RULES.map((x) => noSize(x.anomaly)))
    expect((await storedRules(r)).map((x) => x.anomaly.stateBytesPerSeries)).toEqual(OLD_RULES.map((x) => estimateStateBytes(x.anomaly.detector, x.anomaly.params, MIN)))
    expect(OLD_RULES.map((x) => x.anomaly.stateBytesPerSeries)).toEqual([1400, 11768, 8340])
    expect(OLD_RULES.map((x) => estimateStateBytes(x.anomaly.detector, x.anomaly.params, MIN, 2))).toEqual([1400, 5332, 7995])
    expect(new Set((await r.rows()).map((x) => x.rule_key)), 'the detector state carried over').toEqual(keys)
    expect(again.warnings).toEqual(expect.arrayContaining([
      { path: 'groups[0].rules[0].anomaly.detector', message: 'this rule keeps detector ewma, the default when it was saved; a new rule would get robust_z with the quantile spread (design D33)', fix: expect.any(String) },
      { path: 'groups[0].rules[1].anomaly.params', message: 'this rule keeps spread "mad", windowPoints 288, k 3.5, the default when it was saved; a new rule would get spread "quantile", windowPoints 1500, k 2 (design D33)', fix: expect.any(String) },
      { path: 'groups[0].rules[2].anomaly.params', message: 'this rule keeps spread "mad", seasons 4, k 4, the default when it was saved; a new rule would get spread "quantile", seasons 1, k 2 (design D33)', fix: expect.any(String) },
    ]))
    // Changing a parameter without naming the detector edits the EWMA rule; it does not switch detector.
    const input = before20261119.input.groups[0]!
    const edited = (rule0: Record<string, unknown>, extra: Record<string, unknown>[] = []) => ({ groups: [{ ...input, rules: [rule0, ...input.rules.slice(1), ...extra] }] })
    ok(await r.stub.saveGroups(r.tenant, edited({ ...input.rules[0], anomaly: { unit: 'ms', params: { k: 9 } } })))
    expect((await storedRules(r))[0]!.anomaly).toMatchObject({ detector: 'ewma', given: ['k'], params: { k: 9, halfLifePoints: 100 } })
    // Parameters that are not EWMA's describe another detector: today's default.
    ok(await r.stub.saveGroups(r.tenant, edited({ ...input.rules[0], anomaly: { unit: 'ms', params: { windowPoints: 1000 } } })))
    expect((await storedRules(r))[0]!.anomaly).toMatchObject({ detector: 'robust_z', given: ['windowPoints'], params: { windowPoints: 1000, spread: 'quantile', k: 2 } })
    // Named, it changes; a new rule beside it gets today's default.
    const named = ok(await r.stub.saveGroups(r.tenant, edited({ ...input.rules[0], anomaly: { unit: 'ms', detector: 'robust_z' } }, [{ alert: 'Another', expr: LAT, anomaly: {} }])))
    const now = await storedRules(r)
    expect(now[0]!.anomaly).toMatchObject({ detector: 'robust_z', params: { ...ROBUST_Z_DEFAULTS } })
    expect(now.find((x) => x.name === 'Another')!.anomaly).toMatchObject({ detector: 'robust_z', params: { ...ROBUST_Z_DEFAULTS } })
    expect(named.warnings.filter((w) => w.path === 'groups[0].rules[0].anomaly.detector')).toEqual([])
    // robust_z and seasonal still named without a spread keep the MAD they were stored with throughout.
    expect(now.slice(1, 3).map((x) => noSize(x.anomaly))).toEqual(OLD_RULES.slice(1).map((x) => noSize(x.anomaly)))
  })

  it('through the monitors API: a monitor stored as EWMA (as one saved without a detector was) and edited with the detector left out, even renamed, stays EWMA; naming one changes it', async () => {
    world.now = T0
    const tenant = newTenant('anu')
    const key = await apiKey(tenant)
    ok(await rulerStub(tenant).configure(tenant, { deadman: false, heartbeatMs: 30 * MIN }))
    // Saved with detector "ewma" and nothing else, the stored form is the one the release before the
    // change wrote for a monitor that named no detector (the fixture's first rule): detector,
    // parameters and `given` alike.
    const id = (await call(key.auth, 'POST', '/api/v1/monitors', { name: 'checkout latency', query: LAT, anomaly: { detector: 'ewma' } })).json.id as string
    const get = async () => (await call(key.auth, 'GET', `/api/v1/monitors/${id}`)).json.monitor as MonitorView
    expect((await get()).anomaly).toMatchObject({ detector: 'ewma', params: oldRule('LatencyAnomaly').anomaly.params, given: [] })
    const put = await call(key.auth, 'PUT', `/api/v1/monitors/${id}`, { name: 'checkout latency (p50)', query: LAT, anomaly: {} })
    expect(put.status, put.text).toBe(200)
    expect(put.json.warnings).toEqual(expect.arrayContaining([{ path: 'anomaly.detector', message: expect.stringMatching(/^this rule keeps detector ewma, the default when it was saved/), fix: expect.any(String) }]))
    expect((await get()).anomaly).toMatchObject({ detector: 'ewma', params: oldRule('LatencyAnomaly').anomaly.params })
    expect((await call(key.auth, 'PUT', `/api/v1/monitors/${id}`, { name: 'checkout latency (p50)', query: LAT, anomaly: { detector: 'robust_z' } })).status).toBe(200)
    expect((await get()).anomaly).toMatchObject({ detector: 'robust_z', params: { ...ROBUST_Z_DEFAULTS } })
  })

  it('the 4,000-point configuration confirmed on SMD stays nameable: refused at save over the per-series state limit, with why and what fits; accepted where the operator raised the limit (as ring blocks, the next release, it fits: anomalystore.test.ts)', async () => {
    const { tenant, stub } = await setup()
    const save = (anomaly: Record<string, unknown>) => stub.saveGroups(tenant, { groups: [{ name: 'g', interval: '1m', rules: [{ alert: 'Z', expr: LAT, anomaly }] }] })
    expect(await save({ detector: 'robust_z', params: { windowPoints: 4000 } })).toMatchObject({
      status: 'invalid',
      errors: [{
        path: 'groups[0].rules[0].anomaly.params',
        message: 'robust_z with these parameters keeps about 145400 bytes of state per series at a 1m interval; the limit is 65536. This is the configuration frozen on NAB and confirmed on SMD (42.8); its window is over this ruler\'s per-series state limit',
        fix: expect.stringMatching(/^Use a shorter window: windowPoints 1500, the default, is the largest whose state fits 65,536 bytes a series for any values \(NAB held out 42.6, SMD 42.5 post hoc\)\. A longer window needs the operator to raise RulerLimits.maxAnomalyStateBytesPerSeries\.$/),
      }],
    })
    const raised = await setup({ limits: { maxAnomalyStateBytesPerSeries: 160_000 } })
    const okd = ok(await raised.stub.saveGroups(raised.tenant, { groups: [{ name: 'g', interval: '1m', rules: [{ alert: 'Z', expr: LAT, anomaly: { detector: 'robust_z', params: { windowPoints: 4000 } } }] }] }))
    expect(okd.warnings).toEqual([expect.objectContaining({ path: 'groups[0].rules[0].anomaly.max_series', message: expect.stringMatching(/^max_series defaults to 7 here/) })])
    // spread "mad", given: the library's own defaults, as before, and the evidence against it.
    const mad = ok(await save({ detector: 'robust_z', params: { spread: 'mad' } }))
    expect(mad.warnings.map((w) => w.path)).toEqual(['groups[0].rules[0].anomaly.max_series', 'groups[0].rules[0].anomaly.params.spread'])
    expect(ok(await stub.listGroups(tenant)).groups[0]!.anomalyRules![0]!.anomaly.params).toMatchObject({ spread: 'mad', windowPoints: 288, k: 3.5 })
    // seasonal named without a spread: the configuration frozen on NAB and confirmed on SMD.
    const seasonal = ok(await save({ detector: 'seasonal', params: { periodMs: 60 * MIN } }))
    expect(seasonal.warnings, 'the quantile spread is not warned about').toEqual([])
    expect(ok(await stub.listGroups(tenant)).groups[0]!.anomalyRules![0]!.anomaly.params).toMatchObject({ seasons: 1, k: 2, adapt: 'robust', spread: 'quantile', spreadQuantile: 0.99, periodMs: 60 * MIN })
  })

  it('PREVIOUS_DEFAULTS is what the release before the change stored for an entry that left the fields out (the fixture), and not today\'s defaults', () => {
    const noDetector = oldRule('LatencyAnomaly').anomaly
    expect(noDetector.given).toEqual([])
    expect(noDetector.detector).toBe(PREVIOUS_DEFAULTS.detector)
    for (const name of ['LatencyRobust', 'LatencySeasonal']) {
      const a = oldRule(name).anomaly
      const before = PREVIOUS_DEFAULTS.params[a.detector]!
      expect(Object.keys(before).length, name).toBeGreaterThan(0)
      for (const [k, v] of Object.entries(before)) {
        expect(a.params[k], `${name}.${k}`).toBe(v)
        expect(a.given, `${name}.${k}`).not.toContain(k)
      }
    }
    expect(PREVIOUS_DEFAULTS.detector).not.toBe(DEFAULT_DETECTOR)
    expect(PREVIOUS_DEFAULTS.params.robust_z!.spread).not.toBe(ROBUST_Z_DEFAULTS.spread)
  })

  it('the default window fits the per-series state limit for any values: 1,500 points of the longest-printing numbers, under labels of eight names, are stored without a refusal', () => {
    const parsed = parseRuleFile({ groups: [{ name: 'g', interval: '1m', rules: [{ alert: 'Z', expr: LAT, anomaly: { max_series: 1 } }] }] }, DEFAULT_RULER_CONFIG)
    expect(parsed.errors).toEqual([])
    const rule = parsed.groups[0]!.anomalyRules![0]!
    expect(rule.anomaly.detector).toBe('robust_z')
    const W = rule.anomaly.params.windowPoints as number
    const labels = { __name__: 'http_request_duration_seconds', service: 'checkout', instance: '10.0.12.34:9090', job: 'api', region: 'eu-west-1', cluster: 'prod-2', namespace: 'payments', pod: 'checkout-7d9f8b6c5d-x2x9q' }
    // -1.2345678901234567e-6 prints as -0.0000012345678901234567: 25 characters, the longest a value takes.
    const value = (i: number) => -0.0000012345678901234567 * (1 + (i % 13) / 7)
    const ts = Array.from({ length: W + 10 }, (_, i) => T0 + i * MIN)
    const lib = libraryBatch('robust_z', { ...rule.anomaly.params }, ts, ts.map((_t, i) => value(i)))
    const rt = newAnomalyRt(rule)
    rt.series.set(fingerprint(labels), { labels, state: lib.state, last: null, seenAt: ts.at(-1)! })
    const limits = anomalyLimits(DEFAULT_RULER_CONFIG)
    const next = T0 + ts.length * MIN
    // Flagged, so that the stored entry carries the explanation too.
    const spikeValue = -0.000031234567890123457
    // As version 1 (JSON, the gate at 1): the longest encoding.
    const r = evalAnomaly(rule, rt, [{ metric: labels, value: spikeValue, text: String(spikeValue) }], next, MIN, limits, {}, true, 1)
    expect(r.ok, r.ok ? '' : r.error).toBe(true)
    if (!r.ok) return
    expect(r.flagged.length).toBe(1)
    const bytes = new TextEncoder().encode(r.json.get(fingerprint(labels))!).length
    expect(bytes).toBe(r.write!.perSeries.get(fingerprint(labels)))
    expect(bytes).toBeLessThanOrEqual(limits.maxAnomalyStateBytesPerSeries)
    // With room to spare for longer labels (measured 60.9 KB at the time of writing).
    expect(bytes).toBeLessThan(limits.maxAnomalyStateBytesPerSeries - 4000)
    // As version 2 (Float64 ring blocks, the gate on): under the estimate the save used, whatever the
    // values print as: the same bytes for the longest-printing values as for small integers.
    const r2 = evalAnomaly(rule, rt, [{ metric: labels, value: spikeValue, text: String(spikeValue) }], next, MIN, limits, {}, true, 2)
    if (!r2.ok) throw new Error(r2.error)
    const v2 = r2.write!.perSeries.get(fingerprint(labels))!
    expect(r2.write!.store.version).toBe(2)
    expect(v2).toBeLessThanOrEqual(estimateStateBytes('robust_z', rule.anomaly.params, MIN, 2))
    expect(v2).toBeLessThan(bytes / 2.5)
    const small = libraryBatch('robust_z', { ...rule.anomaly.params }, ts, ts.map((_t, i) => i % 7))
    const rtSmall = newAnomalyRt(rule)
    rtSmall.series.set(fingerprint(labels), { labels, state: small.state, last: null, seenAt: ts.at(-1)! })
    const s2 = evalAnomaly(rule, rtSmall, [{ metric: labels, value: 3, text: '3' }], next, MIN, limits, {}, true, 2)
    if (!s2.ok) throw new Error(s2.error)
    const sizeOf = (w: NonNullable<typeof s2.write>) => [...w.store.entries.values()].reduce((n, m) => n + (m.get(fingerprint(labels)) ?? 0), 0)
    expect(sizeOf(s2.write!)).toBe(sizeOf(r2.write!))
  })
})
