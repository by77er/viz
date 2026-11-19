/**
 * Windowed detector state stored as Float64 ring blocks (`store.anomaly-state` version 2, design
 * D60; `src/anomalystore.ts`). What is checked here:
 *
 * - the stored form is the state, bit for bit: the library's robust z and seasonal states over
 *   random sequences with gaps, missing values and timestamps off the interval grid, written and
 *   read back, equal what JSON (version 1) gives back;
 * - results do not change: the ruler's own evaluation, tick by tick over thousands of ticks with
 *   gaps, evictions (state re-read from the rows) and replayed ticks, gives the same scores, flags,
 *   explanations and statuses from version 2 rows as from version 1 rows; and through the Ruler
 *   object, over the anomaly fixtures and a long random sequence, with evictions and replays, the
 *   alerts, their annotations and the stored state equal those of an object writing version 1;
 * - a tick writes the head and the block of its points (two rows), the same at 18 series as at 100;
 *   one series gone quiet keeps no other series' old entries;
 * - compatibility (contracts/COMPATIBILITY.md): version 1 rows are read and rewritten as version 2
 *   at the next tick, and with the gate at 1 the reverse; rows a newer release wrote are refused and
 *   kept; a shard move carries the rows; rows renumbered 0, 1, … by a release that does not know
 *   version 2 are read by what they say and rewritten whole.
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { DETECTORS } from '../../anomaly/src/index.ts'
import type { AnomalyRuleV2, RuleGroup } from '../contracts-proposal/rules.v2'
import { anomalyLimits, estimateStateBytes, evalAnomaly, maxRobustWindow, newAnomalyRt, readAnomalyRows, type AnomalyRt } from '../src/anomaly'
import { ANOMALY_BLOCK, base64ToF64, emptyStore, f64ToBase64, HEAD_CHUNK, planV2, type AnomalyWrite } from '../src/anomalystore'
import { anomalyCpu, anomalyStateBytes } from '../src/history'
import { DEFAULT_RULER_CONFIG } from '../src/ruler'
import { ANOMALY_STATE_READS, ANOMALY_STATE_WRITE } from '../src/schema'
import { parseRuleFile } from '../src/rules'
import { fingerprint, hash64 } from '../src/util'
import before20261119 from './fixtures/anomaly/before-2026-11-19.json'
import { T0, tenantWorld as tenantWorldOf, world } from './harness'
import { MIN, newTenant, ok, rulerStub, setup, vec } from './helpers'

const LAT = 'latency_ms'
const CFG = { ...DEFAULT_RULER_CONFIG, limits: { ...DEFAULT_RULER_CONFIG.limits, maxAnomalyStateBytesPerRule: 16_000_000, maxAnomalyStateBytesPerObject: 64_000_000 } }
const LIMITS = anomalyLimits(CFG)

/** An anomaly rule as the ruler stores it, from a rule-file entry. */
function parsed(anomaly: Record<string, unknown>, interval = '1m', cfg: typeof DEFAULT_RULER_CONFIG = CFG): AnomalyRuleV2 {
  const p = parseRuleFile({ groups: [{ name: 'g', interval, rules: [{ alert: 'A', expr: LAT, anomaly }] }] }, cfg)
  if (p.errors.length > 0) throw new Error(JSON.stringify(p.errors))
  return p.groups[0]!.anomalyRules![0] as AnomalyRuleV2
}

/** A seeded generator (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** `anomaly_state` of one rule in memory, written as the Ruler's transaction writes it. */
class Table {
  rows = new Map<number, string>()
  writes: number[] = []
  apply(w: AnomalyWrite) {
    let n = 0
    if (w.purge) {
      n += this.rows.size
      this.rows.clear()
    }
    for (const u of w.upserts) {
      this.rows.set(u.chunk, u.body)
      n++
    }
    for (const c of w.deletes) if (this.rows.delete(c)) n++
    if (w.deleteFrom !== null) for (const c of [...this.rows.keys()]) if (c >= w.deleteFrom && this.rows.delete(c)) n++
    this.writes.push(n)
  }
  list() {
    return [...this.rows.entries()].sort((a, b) => a[0] - b[0]).map(([chunk, body]) => ({ chunk, body }))
  }
}

/** What JSON (version 1) gives back for a state: the reference the binary form must equal. */
const viaJson = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

type Det = { detect(s: { ts: Float64Array; values: Float64Array }, p: unknown, st: unknown): { state: unknown; points: unknown[] } }

describe('the stored form is the state, bit for bit', () => {
  it('Float64 values round-trip exactly through base64, −0 as 0 (as JSON writes it)', () => {
    const r = rng(7)
    const xs = Array.from({ length: 997 }, (_, i) => (i % 5 === 0 ? (r() - 0.5) * 10 ** Math.floor(r() * 300 - 150) : i % 7 === 0 ? -0 : i % 11 === 0 ? NaN : r() * 1e6 - 5e5))
    const back = base64ToF64(f64ToBase64(xs))
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i]!
      if (x !== x) expect(back[i]).toBeNaN()
      else expect(Object.is(back[i], x === 0 ? 0 : x), `index ${i}: ${x}`).toBe(true)
    }
    // Not Float32: a value that needs 53 bits keeps them.
    expect(base64ToF64(f64ToBase64([0.1 + 0.2]))[0]).toBe(0.30000000000000004)
  })

  const CONFIGS: [string, Record<string, unknown>, string][] = [
    ['robust_z, 50 points', { detector: 'robust_z', params: { windowPoints: 50, minPoints: 5 } }, '1m'],
    ['robust_z, the default (1,500 points)', {}, '1m'],
    ['robust_z, a 37-minute window (not whole blocks)', { detector: 'robust_z', params: { windowMs: 37 * MIN, minPoints: 5 } }, '1m'],
    ['seasonal, 30 minutes × 2, MAD', { detector: 'seasonal', params: { periodMs: 30 * MIN, seasons: 2, spread: 'mad' } }, '1m'],
    ['seasonal, the quantile default, hourly', { detector: 'seasonal', params: { periodMs: 60 * MIN } }, '1m'],
    ['seasonal, daily at 5 minutes', { detector: 'seasonal', params: { periodMs: 24 * 60 * MIN } }, '5m'],
  ]

  it.each(CONFIGS)('%s: the library\'s state over a random sequence (gaps, missing values, points off the grid), written whole and read back, equals what JSON gives back', (_label, anomaly, interval) => {
    const rule = parsed(anomaly, interval)
    const I = interval === '5m' ? 5 * MIN : MIN
    const det = DETECTORS[rule.anomaly.detector as keyof typeof DETECTORS] as unknown as Det
    const params = { ...rule.anomaly.params, stepMs: I, unit: '' }
    for (const seed of [1, 2, 3]) {
      const r = rng(seed)
      let state: unknown = null
      let ts = 1.8e12 + Math.floor(r() * I)
      const n = 2500
      for (let i = 0; i < n; i++) {
        ts += I * (r() < 0.05 ? 1 + Math.floor(r() * 40) : 1)
        // After step 1,800, a query offset that changed: every point 17 s off the grid it started on.
        const at = i > 1800 ? ts + 17_000 : ts
        const v = r() < 0.03 ? NaN : 100 + 10 * Math.sin(i / 30) + (r() - 0.5) * 6 + (r() < 0.01 ? 200 : 0)
        state = det.detect({ ts: Float64Array.of(at), values: Float64Array.of(v) }, params, state).state
        if (i % 97 === 0 || i === n - 1) {
          const series = new Map([['k1', { labels: { s: 'x' }, state, last: null, seenAt: at }]])
          const w = planV2(rule.anomaly.detector, I, rule.anomaly.detector === 'robust_z' ? windowOf(rule, I) : null, emptyStore(), series, new Set(), true)
          if (!w) throw new Error('not encoded')
          const t = new Table()
          t.apply(w)
          const back = readAnomalyRows(t.list())
          if ('error' in back) throw new Error(back.error)
          expect(back.series.get('k1')!.state, `seed ${seed}, step ${i}`).toEqual(viaJson(state))
        }
      }
    }
  })
})

/** robust_z's window for a parsed rule (what `windowMsOf` computes), for the pure round trip above. */
function windowOf(rule: AnomalyRuleV2, I: number): number {
  const p = rule.anomaly.params as Record<string, number>
  return (p.windowMs ?? 0) > 0 ? p.windowMs! : p.windowPoints! * I
}

describe('results do not change: the ruler\'s evaluation from version 2 rows equals it from version 1 rows', () => {
  const CASES: [string, Record<string, unknown>, number][] = [
    ['robust_z, the default window (1,500 points), 2,200 ticks', {}, 2200],
    ['robust_z, 200 points, 1,200 ticks', { detector: 'robust_z', params: { windowPoints: 200, minPoints: 5 } }, 1200],
    ['seasonal, hourly, 2 seasons, MAD, 700 ticks', { detector: 'seasonal', params: { periodMs: 60 * MIN, seasons: 2, spread: 'mad' } }, 700],
    ['seasonal, the quantile default, hourly, 700 ticks', { detector: 'seasonal', params: { periodMs: 60 * MIN } }, 700],
  ]
  it.each(CASES)('%s: gaps, missing values, evictions and replays; identical flags, explanations, scores and statuses at every tick, and two rows a steady tick', (_label, anomaly, ticks) => {
    const rule = parsed({ ...anomaly, max_series: 4 })
    const r = rng(ticks)
    type Run = { rt: AnomalyRt; table: Table; version: 1 | 2 }
    const runs: Run[] = [1, 2].map((version) => ({ rt: newAnomalyRt(rule), table: new Table(), version: version as 1 | 2 }))
    const reload = (run: Run) => {
      const read = readAnomalyRows(run.table.list())
      if ('error' in read) throw new Error(read.error)
      run.rt = { ...newAnomalyRt(rule), series: read.series, json: read.json, store: read.store }
    }
    const services = ['a', 'b', 'c']
    let ts = 1.8e12 + 23_456
    const tickOf = (run: Run, at: number, series: { metric: Record<string, string>; value: number; text: string }[]) => {
      const ev = evalAnomaly(rule, run.rt, series, at, MIN, LIMITS, {}, true, run.version)
      if (!ev.ok) throw new Error(ev.error)
      if (ev.changed && ev.write) {
        run.table.apply(ev.write)
        run.rt = { ...run.rt, series: ev.next, json: ev.json, store: ev.write.store, status: ev.status, pruned: ev.status.pruned }
      }
      return { flagged: ev.flagged, status: { ...ev.status, stateBytes: 0 }, changed: ev.changed }
    }
    for (let i = 0; i < ticks; i++) {
      ts += MIN
      const series = services
        // b goes away now and then (a gap: not returned at all); c returns a missing value now and then.
        .filter((s) => !(s === 'b' && (i % 150 > 130 || r() < 0.02)))
        .map((s) => {
          const v = s === 'c' && r() < 0.03 ? NaN : (s === 'a' ? 50 : 100) + 8 * Math.sin(i / 20) + (r() - 0.5) * 4 + (r() < 0.01 ? 120 : 0)
          return { metric: { service: s }, value: v, text: String(v) }
        })
      const out = runs.map((run) => tickOf(run, ts, series))
      expect(out[1], `tick ${i}`).toEqual(out[0])
      if (r() < 0.04) {
        // Evicted: memory is rebuilt from the rows alone; then the same tick delivered again.
        for (const run of runs) reload(run)
        const again = runs.map((run) => tickOf(run, ts, series))
        expect(again[1], `tick ${i}, replayed`).toEqual(again[0])
        expect(again.map((a) => a.changed), 'a replay changes nothing').toEqual([false, false])
        expect(again[1]!.flagged).toEqual(out[1]!.flagged)
      }
    }
    for (const run of runs) reload(run)
    expect(runs[1]!.rt.series).toEqual(runs[0]!.rt.series)
    // Version 2: the head and one block a steady tick; three where a block is left behind (deleted or
    // rewritten); never every block.
    const w2 = runs[1]!.table.writes
    const blocks = runs[1]!.table.list().filter((x) => x.chunk > HEAD_CHUNK + 1e6).length
    expect(blocks).toBeGreaterThanOrEqual(rule.anomaly.detector === 'robust_z' ? 4 : 2)
    expect(Math.max(...w2.slice(1))).toBeLessThanOrEqual(4)
    expect(w2.filter((n) => n === 2).length / w2.length).toBeGreaterThan(0.85)
  })

  it('one series gone quiet keeps no other series\' old entries: stored bytes stay within the estimates, blocks within the windows; a pruned series is in no row', async () => {
    const rule = parsed({ detector: 'robust_z', params: { windowPoints: 120, minPoints: 5 }, max_series: 10 })
    let rt = newAnomalyRt(rule)
    const table = new Table()
    let ts = 1.8e12
    const most: number[] = []
    const totals: number[] = []
    for (let i = 0; i < 900; i++) {
      ts += MIN
      // After 100 ticks "quiet" answers with a missing value at every tick (seen, so never pruned:
      // its window stays where it was) and "gone" is not returned (pruned after its window); x and y go on.
      const names = i < 100 ? ['gone', 'quiet', 'x', 'y'] : ['quiet', 'x', 'y']
      const ev = evalAnomaly(rule, rt, names.map((s) => ({ metric: { service: s }, value: s === 'quiet' && i >= 100 ? NaN : 100 + (i % 7), text: '' })), ts, MIN, LIMITS, {}, true, 2)
      if (!ev.ok) throw new Error(ev.error)
      table.apply(ev.write!)
      rt = { ...rt, series: ev.next, json: ev.json, store: ev.write!.store, status: ev.status }
      most.push(Math.max(...ev.write!.perSeries.values()))
      totals.push(ev.write!.bytes)
    }
    // 120 points span at most 3 blocks of 60: within the per-series estimate at every tick, and the
    // rule within the estimate of its series; quiet's 3 old blocks and x's and y's 3 current ones.
    const est = estimateStateBytes('robust_z', rule.anomaly.params, MIN, 2)
    expect(Math.max(...most)).toBeLessThanOrEqual(est)
    expect(Math.max(...totals.slice(300))).toBeLessThanOrEqual(3 * est)
    const blocks = table.list().filter((x) => x.chunk > HEAD_CHUNK + 1e6)
    expect(blocks.length).toBeLessThanOrEqual(6)
    expect(rt.series.size).toBe(3)
    expect(table.list().some((b) => b.body.includes(fingerprint({ service: 'gone' })))).toBe(false)
    // quiet's window is still read back whole from its old blocks.
    const back = readAnomalyRows(table.list())
    if ('error' in back) throw new Error(back.error)
    expect(back.series).toEqual(rt.series)
  })

  it('the caps in effect follow the version written (JSON in this release: 18 series at the default window); the ring blocks of the next release bring 55, and the 4,000-point window within the limit; the CPU and memory models price robust z by the points it scans either way', () => {
    const rule = parsed({}, '1m', DEFAULT_RULER_CONFIG)
    expect(rule.anomaly).toMatchObject({ stateBytesPerSeries: estimateStateBytes('robust_z', rule.anomaly.params, MIN), maxSeries: Math.floor(1_048_576 / estimateStateBytes('robust_z', rule.anomaly.params, MIN)) })
    const size = (version: 1 | 2, windowPoints = 1500) => estimateStateBytes('robust_z', { ...rule.anomaly.params, windowPoints }, MIN, version)
    expect([size(1), Math.floor(1_048_576 / size(1)), size(1, 4000), maxRobustWindow(65_536, 1)]).toEqual([55_400, 18, 145_400, 1781])
    expect([size(2), Math.floor(1_048_576 / size(2)), size(2, 4000), Math.floor(1_048_576 / size(2, 4000)), maxRobustWindow(65_536, 2)]).toEqual([18_772, 55, 46_996, 22, 5641])
    // 1.5 + 3 + 0.0063 × 55,400 (the window's size as JSON, which the price was calibrated against), whatever is written.
    expect(anomalyCpu(rule, MIN)).toBeCloseTo(1.5 + 3 + 0.0063 * 55_400, 6)
    expect(anomalyStateBytes(rule, MIN)).toBe(rule.anomaly.maxSeries * 55_400 * 3)
    const confirmed = parsed({ detector: 'robust_z', params: { windowPoints: 4000 } }, '1m', { ...DEFAULT_RULER_CONFIG, limits: { ...DEFAULT_RULER_CONFIG.limits, maxAnomalyStateBytesPerSeries: 160_000 } })
    expect(anomalyCpu(confirmed, MIN)).toBeCloseTo(1.5 + 3 + 0.0063 * 145_400, 6)
    // A rule stored by the release that writes ring blocks (a smaller stateBytesPerSeries) is priced the same.
    expect(anomalyCpu({ ...rule, anomaly: { ...rule.anomaly, stateBytesPerSeries: 18_772 } }, MIN)).toBe(anomalyCpu(rule, MIN))
  })
})

/** Ticks a tenant's object once at the clock (its alarm must be due). */
async function tick(stub: ReturnType<typeof rulerStub>, tenant: string) {
  world.now = Math.max(world.now, ok(await stub.health(tenant)).alarmAtMs!)
  expect(await runDurableObjectAlarm(stub)).toBe(true)
}

/** Two tenants whose `anomalies/1m` groups tick at the same times (equal offsets), one writing each version. */
async function twins(prefix: string) {
  const a = newTenant(`${prefix}a`)
  const offset = (t: string) => parseInt(hash64(`${t}/0/anomalies/1m`).slice(0, 12), 16) % MIN
  let b = newTenant(`${prefix}b`)
  while (offset(b) !== offset(a)) b = newTenant(`${prefix}b`)
  const A = await setup({ heartbeatMs: 30 * MIN }, a)
  const B = await setup({ heartbeatMs: 30 * MIN }, b)
  A.w.anomalyStateWrite = 1
  B.w.anomalyStateWrite = 2
  return [A, B] as const
}

const rowsOf = (stub: ReturnType<typeof rulerStub>, tenant: string) =>
  runInDurableObject(stub, (_i, s) => s.storage.sql.exec('SELECT rule_key, chunk, body FROM anomaly_state WHERE tenant = ? ORDER BY rule_key, chunk', tenant).toArray() as { rule_key: string; chunk: number; body: string }[])

/** Every rule's decoded state, by rule key. */
async function states(stub: ReturnType<typeof rulerStub>, tenant: string) {
  const rows = await rowsOf(stub, tenant)
  const out: Record<string, unknown> = {}
  for (const key of new Set(rows.map((r) => r.rule_key))) {
    const read = readAnomalyRows(rows.filter((r) => r.rule_key === key))
    if ('error' in read) throw new Error(read.error)
    out[key] = Object.fromEntries([...read.series].map(([k, s]) => [k, s]))
  }
  return out
}

describe('through the Ruler object: version 2 changes no alert', () => {
  it('over the anomaly fixtures (EWMA, robust z and seasonal with the MAD) and today\'s defaults (robust z and seasonal, quantile spread), 1,700 random ticks with gaps, missing values, evictions and replays: the same alerts, annotations and statuses at every tick, and the same state', async () => {
    const [A, B] = await twins('eq')
    const OLD = JSON.parse(before20261119.stored) as RuleGroup
    const extra = [
      { alert: 'Robust', expr: LAT, anomaly: { max_series: 10 } },
      { alert: 'Seasonal', expr: LAT, anomaly: { detector: 'seasonal', params: { periodMs: 60 * MIN }, max_series: 10 } },
    ]
    for (const T of [A, B]) {
      ok(await T.stub.saveGroups(T.tenant, { groups: [{ name: 'anomalies/1m', interval: '1m', rules: extra }] }))
      // The fixture's three rules, as the release before 2026-11-19 stored them, beside today's two.
      await runInDurableObject(T.stub, (_i, s) => {
        const spec = JSON.parse(s.storage.sql.exec('SELECT spec FROM rule_group WHERE tenant = ?', T.tenant).one().spec as string) as RuleGroup
        spec.anomalyRules = [...(OLD.anomalyRules ?? []), ...(spec.anomalyRules ?? [])]
        s.storage.sql.exec('UPDATE rule_group SET spec = ? WHERE tenant = ?', JSON.stringify(spec), T.tenant)
        s.storage.sql.exec('DELETE FROM warmup WHERE tenant = ?', T.tenant)
      })
      await evictDurableObject(T.stub)
    }
    const r = rng(42)
    const times: number[] = []
    const values: Map<string, number | string>[] = []
    for (const T of [A, B]) {
      T.w.evaluate = (q, t) => {
        if (q !== LAT) return vec()
        if (!times.includes(t)) {
          times.push(t)
          const i = times.length - 1
          const m = new Map<string, number | string>()
          for (const s of ['a', 'b', 'c']) {
            if (s === 'b' && (i % 300 > 280 || r() < 0.02)) continue
            m.set(s, s === 'c' && r() < 0.03 ? 'NaN' : (s === 'a' ? 50 : 100) + 8 * Math.sin(i / 20) + (r() - 0.5) * 4 + (r() < 0.01 ? 150 : 0))
          }
          values.push(m)
        }
        return vec(...[...values[times.indexOf(t)]!].map(([s, v]): [Record<string, string>, number | string] => [{ service: s }, v]))
      }
    }
    const view = async (T: typeof A) => {
      const rules = ok(await T.stub.rules(T.tenant)).rules
      return rules.map((x) => ({ name: x.name, health: x.health, status: x.anomaly ? { ...x.anomaly, stateBytes: 0, warmup: null } : null, alerts: x.alerts.map((a) => ({ labels: a.labels, state: a.state, annotations: a.annotations, value: a.value, activeAt: a.activeAt })) }))
    }
    let replays = 0
    let evictions = 0
    let fired = 0
    world.now = T0
    for (let i = 0; i < 1700; i++) {
      await tick(A.stub, A.tenant)
      await tick(B.stub, B.tenant)
      const [va, vb] = [await view(A), await view(B)]
      expect(vb, `tick ${i}`).toEqual(va)
      fired += va.reduce((n, x) => n + x.alerts.filter((a) => a.state === 'firing').length, 0)
      const roll = r()
      if (roll < 0.03) {
        evictions++
        for (const T of [A, B]) await evictDurableObject(T.stub)
      } else if (roll < 0.05) {
        // The tick delivered again after an eviction (the heartbeat cursor is behind).
        replays++
        for (const T of [A, B]) {
          await evictDurableObject(T.stub)
          await runInDurableObject(T.stub, (inst) => inst.alarm())
        }
        expect(await view(B), `tick ${i}, replayed`).toEqual(await view(A))
      }
    }
    expect(await states(B.stub, B.tenant)).toEqual(await states(A.stub, A.tenant))
    expect([evictions, replays, fired].every((n) => n > 0), JSON.stringify({ evictions, replays, fired })).toBe(true)
    // A wrote version 1 for every rule; B version 2 for robust z and seasonal and 1 for EWMA.
    const versions = async (T: typeof A) => [...new Set((await rowsOf(T.stub, T.tenant)).map((x) => (JSON.parse(x.body) as { v: number }).v))].sort()
    expect(await versions(A)).toEqual([1])
    expect(await versions(B)).toEqual([1, 2])
  }, 600_000)

  it('a tick writes the head and the block of its points: two rows at 18 series and at 100, where version 1 rewrote every row of the state', async () => {
    const rowsPerTick = async (series: number, version: 1 | 2) => {
      const { tenant, stub, w } = await setup({ heartbeatMs: 24 * 60 * MIN, limits: { maxAnomalyStateBytesPerRule: 16_000_000, maxAnomalyStateBytesPerObject: 64_000_000 } })
      w.anomalyStateWrite = version
      ok(await stub.saveGroups(tenant, { groups: [{ name: 'anomalies/1m', interval: '1m', rules: [{ alert: 'R', expr: LAT, anomaly: { detector: 'robust_z', params: { windowPoints: 300, minPoints: 5 }, max_series: series } }] }] }))
      let i = 0
      w.evaluate = (q) => (q === LAT ? vec(...Array.from({ length: series }, (_x, s): [Record<string, string>, number] => [{ service: `s${s}` }, 100 + ((i * 31 + s * 7) % 13)])) : vec())
      const per: number[] = []
      for (; i < 140; i++) {
        const w0 = ok(await stub.health(tenant)).counters.sqlRowsWritten
        await tick(stub, tenant)
        per.push(ok(await stub.health(tenant)).counters.sqlRowsWritten - w0)
      }
      return per.slice(1)
    }
    const v2 = [await rowsPerTick(18, 2), await rowsPerTick(100, 2)]
    expect(v2[0]).toEqual(v2[1])
    // The head and the current block; once a block is full a third (the next block's first row is an insert, not more).
    expect(Math.max(...v2[0]!)).toBeLessThanOrEqual(3)
    expect(v2[0]!.filter((n) => n === 2).length).toBeGreaterThan(130)
    const v1 = [await rowsPerTick(18, 1), await rowsPerTick(100, 1)]
    expect(Math.max(...v1[1]!)).toBeGreaterThanOrEqual(Math.max(...v1[0]!))
  }, 300_000)
})

describe('compatibility: read both, write the gate\'s version; refuse what a newer release wrote', () => {
  const rule = { alert: 'R', expr: LAT, anomaly: { detector: 'robust_z', params: { windowPoints: 90, minPoints: 5 }, max_series: 5 } }
  /** A tenant ticking one robust z rule; the same values by tick index. */
  async function one(version: 1 | 2, tenant = newTenant('cv')) {
    const T = await setup({ heartbeatMs: 30 * MIN }, tenant)
    T.w.anomalyStateWrite = version
    ok(await T.stub.saveGroups(T.tenant, { groups: [{ name: 'anomalies/1m', interval: '1m', rules: [rule] }] }))
    let i = 0
    T.w.evaluate = (q) => (q === LAT ? vec([{ service: 'a' }, 100 + ((i * 37) % 7)], [{ service: 'b' }, i++ === 120 ? 400 : 50 + ((i * 11) % 5)]) : vec())
    return T
  }
  const vOf = (rows: { body: string }[]) => [...new Set(rows.map((x) => (JSON.parse(x.body) as { v: number }).v))]

  it('readers first: this release (the gate as shipped) writes version 1; the next (the gate on) reads those rows and rewrites them as version 2 at the next tick; rolled back to this release, it reads version 2 and rewrites it as version 1; the alerts and the state are those of a run that never changed', async () => {
    const ref = await one(2)
    // This release, its gate as shipped (ANOMALY_STATE_WRITE): reads versions 1 and 2, writes 1.
    const cv = await one(ANOMALY_STATE_WRITE)
    expect(ANOMALY_STATE_READS).toEqual([1, 2])
    for (let k = 0; k < 100; k++) {
      await tick(ref.stub, ref.tenant)
      await tick(cv.stub, cv.tenant)
    }
    expect(vOf(await rowsOf(cv.stub, cv.tenant))).toEqual([1])
    // The next release (the gate on), the object evicted: it reads version 1 and converts.
    cv.w.anomalyStateWrite = 2
    await evictDurableObject(cv.stub)
    for (let k = 0; k < 30; k++) {
      await tick(ref.stub, ref.tenant)
      await tick(cv.stub, cv.tenant)
    }
    const rows = await rowsOf(cv.stub, cv.tenant)
    expect(vOf(rows)).toEqual([2])
    expect(rows[0]!.chunk).toBe(HEAD_CHUNK)
    // Rolled back to this release (its gate as shipped): it reads the version 2 rows the next one wrote, and writes 1.
    cv.w.anomalyStateWrite = ANOMALY_STATE_WRITE
    await evictDurableObject(cv.stub)
    for (let k = 0; k < 10; k++) {
      await tick(ref.stub, ref.tenant)
      await tick(cv.stub, cv.tenant)
    }
    expect(vOf(await rowsOf(cv.stub, cv.tenant))).toEqual([1])
    // Times differ (two tenants, two offsets): compare what the detector decided, then the windows' values.
    const decided = async (T: typeof ref) => ok(await T.stub.rules(T.tenant)).rules.map((x) => ({ alerts: x.alerts.map((a) => [a.labels.service, a.state, JSON.parse(a.annotations.anomaly_detail ?? 'null')?.score]), anomaly: { ...x.anomaly, stateBytes: 0, warmup: null } }))
    expect(await decided(cv)).toEqual(await decided(ref))
    const values = (st: Record<string, unknown>) => Object.values(Object.values(st)[0] as Record<string, { labels: { service: string }; state: { x: number[] } }>).map((s) => [s.labels.service, s.state.x]).sort()
    expect(values(await states(cv.stub, cv.tenant))).toEqual(values(await states(ref.stub, ref.tenant)))
  }, 300_000)

  it('the suite runs its Ruler objects with the gate it was started with (TEST_ANOMALY_STATE_WRITE=2: the next release\'s writer; unset: this release\'s, version 1)', async () => {
    const T = await setup({ heartbeatMs: 30 * MIN })
    ok(await T.stub.saveGroups(T.tenant, { groups: [{ name: 'anomalies/1m', interval: '1m', rules: [rule] }] }))
    T.w.evaluate = (q) => (q === LAT ? vec([{ service: 'a' }, 100]) : vec())
    for (let k = 0; k < 3; k++) await tick(T.stub, T.tenant)
    const forced = (env as unknown as { TEST_ANOMALY_STATE_WRITE?: string }).TEST_ANOMALY_STATE_WRITE
    expect(vOf(await rowsOf(T.stub, T.tenant))).toEqual([forced === '2' ? 2 : forced === '1' ? 1 : ANOMALY_STATE_WRITE])
  })

  it('rows a newer release wrote (version 3) are refused: state_unreadable, kept, and carried by a shard move as they are', async () => {
    const T = await one(2)
    for (let k = 0; k < 5; k++) await tick(T.stub, T.tenant)
    const key = (await rowsOf(T.stub, T.tenant))[0]!.rule_key
    const newer = [JSON.stringify({ v: 3, part: 'head', note: 'a format from the future' }), JSON.stringify({ v: 3, part: 'block', b: 1 })]
    await runInDurableObject(T.stub, (_i, s) => {
      s.storage.sql.exec('DELETE FROM anomaly_state WHERE tenant = ?', T.tenant)
      newer.forEach((body, i) => s.storage.sql.exec('INSERT INTO anomaly_state (tenant, grp, rule_key, chunk, body) VALUES (?, ?, ?, ?, ?)', T.tenant, 'anomalies/1m', key, HEAD_CHUNK + i, body))
    })
    await evictDurableObject(T.stub)
    await tick(T.stub, T.tenant)
    const st = ok(await T.stub.rules(T.tenant)).rules[0]!
    expect([st.health, st.anomaly!.status]).toEqual(['err', 'state_unreadable'])
    expect(st.lastError).toMatch(/^state_unreadable: anomaly_state row version 3 is not 1 or 2/)
    expect((await rowsOf(T.stub, T.tenant)).map((x) => x.body)).toEqual(newer)
    const bundle = ok(await T.stub.exportGroup(T.tenant, 'anomalies/1m')).bundle
    expect(bundle.anomalyState).toEqual({ [key]: newer })
    const target = rulerStub(T.tenant, '1')
    ok(await target.configure(T.tenant, { deadman: false, heartbeatMs: 30 * MIN }))
    ok(await target.importGroup(T.tenant, bundle))
    expect((await rowsOf(target, T.tenant)).map((x) => x.body)).toEqual(newer)
    expect(ok(await target.rules(T.tenant)).rules[0]!.anomaly!.status).toBe('state_unreadable')
  })

  it('a shard move carries version 2 rows (every row, head first); the target continues exactly as the source would have; rows a release without version 2 renumbered 0, 1, … are read by what they say and rewritten whole', async () => {
    const src = await one(2)
    const ref = await one(2, newTenant('cvref'))
    for (let k = 0; k < 100; k++) {
      await tick(src.stub, src.tenant)
      await tick(ref.stub, ref.tenant)
    }
    const before = await rowsOf(src.stub, src.tenant)
    const bundle = ok(await src.stub.exportGroup(src.tenant, 'anomalies/1m')).bundle
    const bodies = Object.values(bundle.anomalyState!)[0]!
    // Re-encoded whole from the state (points evicted since a block was written are left out).
    expect(bodies.map((b) => (JSON.parse(b) as { v: number; part: string }).part)).toEqual(['head', ...bodies.slice(1).map(() => 'block')])
    expect(bodies.every((b) => (JSON.parse(b) as { v: number }).v === 2)).toBe(true)
    const target = rulerStub(src.tenant, '1')
    ok(await target.configure(src.tenant, { deadman: false, heartbeatMs: 30 * MIN }))
    ok(await target.importGroup(src.tenant, bundle))
    const moved = await rowsOf(target, src.tenant)
    expect(moved.map((x) => x.body)).toEqual(bodies)
    expect(moved.map((x) => x.chunk)).toEqual(bodies.map((b) => { const j = JSON.parse(b) as { part: string; i?: number; b?: number }; return j.part === 'head' ? HEAD_CHUNK + j.i! : j.b! }))
    expect(await states(target, src.tenant)).toEqual(await states(src.stub, src.tenant))
    // The target goes on, on its own tick grid: its points are off the grid the rows started on, and
    // are written as explicit (time, value) pairs, read back exactly.
    let j = 100
    tenantWorldOf(src.tenant).evaluate = (q) => (q === LAT ? vec([{ service: 'a' }, 100 + ((j * 37) % 7)], [{ service: 'b' }, 50 + ((j++ * 11) % 5)]) : vec())
    for (let k = 0; k < 20; k++) await tick(target, src.tenant)
    const st = ok(await target.rules(src.tenant)).rules[0]!
    expect([st.health, st.anomaly!.status, st.anomaly!.scored]).toEqual(['ok', 'ok', 2])
    const ring = await rowsOf(target, src.tenant)
    expect(ring.some((x) => x.body.includes('"e":"'))).toBe(true)
    expect(Object.values(await states(target, src.tenant)).length).toBe(1)

    // As a release that reads only version 1 would have stored them on import: numbered 0, 1, … in order.
    const renumbered = newTenant('cvold')
    const now = world.now
    const old = await setup({ heartbeatMs: 30 * MIN }, renumbered)
    world.now = now
    old.w.anomalyStateWrite = 2
    ok(await old.stub.saveGroups(renumbered, { groups: [{ name: 'anomalies/1m', interval: '1m', rules: [rule] }] }))
    const key = (await rowsOf(src.stub, src.tenant))[0]!.rule_key
    await runInDurableObject(old.stub, (_i, s) => {
      s.storage.sql.exec('DELETE FROM warmup WHERE tenant = ?', renumbered)
      before.forEach((r, chunk) => s.storage.sql.exec('INSERT INTO anomaly_state (tenant, grp, rule_key, chunk, body) VALUES (?, ?, ?, ?, ?)', renumbered, 'anomalies/1m', key, chunk, r.body))
    })
    await evictDurableObject(old.stub)
    expect(await states(old.stub, renumbered)).toEqual(await states(src.stub, src.tenant))
    let i = 100
    old.w.evaluate = (q) => (q === LAT ? vec([{ service: 'a' }, 100 + ((i * 37) % 7)], [{ service: 'b' }, i++ === 120 ? 400 : 50 + ((i * 11) % 5)]) : vec())
    world.now = Math.max(world.now, ok(await old.stub.health(renumbered)).alarmAtMs!)
    expect(await runDurableObjectAlarm(old.stub)).toBe(true)
    const after = await rowsOf(old.stub, renumbered)
    expect(after[0]!.chunk, 'rewritten whole under its own chunk numbers').toBe(HEAD_CHUNK)
    expect(after.slice(1).every((x) => x.chunk === (JSON.parse(x.body) as { b: number }).b)).toBe(true)
    expect(ok(await old.stub.rules(renumbered)).rules[0]!.health).toBe('ok')
  }, 300_000)
})

describe('blocks', () => {
  it('ANOMALY_BLOCK is 60 slots', () => expect(ANOMALY_BLOCK).toBe(60))
})

describe('a missing or partial block is detected, never read as a smaller window (review of D60, m-12)', () => {
  /** Two robust z series on a 1-minute grid: a with 200 points (four blocks), b with every fifth point (explicit pairs). */
  function written() {
    const I = MIN
    const phase = 23_456
    const t0 = phase + 1_000_000 * I
    const robust = (every: number) => {
      const t: number[] = []
      const x: number[] = []
      for (let i = 0; i < 200; i += every) {
        t.push(t0 + i * I)
        x.push(100 + Math.sin(i / 7) * 5 + i / 50)
      }
      return { v: 1, lastTs: t0 + 199 * I, stepMs: I, t, x }
    }
    const last = { ts: t0 + 199 * I, status: 'ok' as const, flag: false, value: 1, score: 0, explanation: null }
    const series = new Map([
      ['a', { labels: { service: 'a' }, state: robust(1), last, seenAt: t0 + 199 * I }],
      ['b', { labels: { service: 'b' }, state: robust(5), last, seenAt: t0 + 199 * I }],
    ])
    const w = planV2('robust_z', I, 400 * I, emptyStore(), series, new Set(), true)!
    const rows = w.upserts.map((u) => ({ chunk: u.chunk, body: u.body }))
    return { rows, series }
  }
  const points = (r: ReturnType<typeof readAnomalyRows>) => ('error' in r ? -1 : [...r.series.values()].reduce((n, s) => n + (s.state as { t: number[] }).t.length, 0))

  it('the head lists the blocks the rows hold and their series entries in all; intact rows read whole', () => {
    const { rows } = written()
    const head = JSON.parse(rows.find((r) => r.chunk === HEAD_CHUNK)!.body) as { blocks: [number, number][]; entries: number }
    const blocks = rows.filter((r) => r.chunk > HEAD_CHUNK + 1e6)
    expect(blocks.length).toBeGreaterThanOrEqual(4)
    expect(head.blocks).toEqual([[blocks[0]!.chunk, blocks[blocks.length - 1]!.chunk]])
    expect(head.entries).toBe(blocks.reduce((n, b) => n + (JSON.parse(b.body) as { series: unknown[] }).series.length, 0))
    expect(points(readAnomalyRows(rows))).toBe(200 + 40)
  })

  it('a missing block row: refused, naming it (it read 536 of 596 points before)', () => {
    const { rows } = written()
    const blocks = rows.filter((r) => r.chunk > HEAD_CHUNK + 1e6)
    const victim = blocks[1]!.chunk
    const r = readAnomalyRows(rows.filter((x) => x.chunk !== victim))
    expect('error' in r ? r.error : 'read').toBe(`anomaly_state is missing block row ${victim} that its head lists`)
    // The first and the last block too.
    for (const b of [blocks[0]!, blocks[blocks.length - 1]!]) expect('error' in readAnomalyRows(rows.filter((x) => x !== b))).toBe(true)
  })

  it('a partial block (one series\' entry gone from a row), an extra block, a head without the list: refused', () => {
    const { rows } = written()
    const blocks = rows.filter((r) => r.chunk > HEAD_CHUNK + 1e6)
    const partial = rows.map((x) => {
      if (x !== blocks[2]) return x
      const body = JSON.parse(x.body) as { series: unknown[] }
      expect(body.series.length).toBe(2)
      return { ...x, body: JSON.stringify({ ...body, series: body.series.slice(0, 1) }) }
    })
    const p = readAnomalyRows(partial)
    expect('error' in p ? p.error : 'read').toMatch(/^anomaly_state blocks hold \d+ series entries; its head counts \d+$/)
    // One entry cut short (a truncated value) is refused as before.
    const cut = rows.map((x) => {
      if (x !== blocks[0]) return x
      const body = JSON.parse(x.body) as { series: { x?: string; e?: string }[] }
      return { ...x, body: JSON.stringify({ ...body, series: body.series.map((e) => (e.x ? { ...e, x: e.x.slice(0, 16) } : e.e ? { ...e, e: e.e.slice(0, 16) } : e)) }) }
    })
    expect('error' in readAnomalyRows(cut)).toBe(true)
    // A block the head does not list (left behind by a write that should have deleted it).
    const last = blocks[blocks.length - 1]!
    const extra = [...rows, { chunk: last.chunk + 5, body: last.body.replace(`"b":${last.chunk}`, `"b":${last.chunk + 5}`) }]
    expect('error' in readAnomalyRows(extra) ? (readAnomalyRows(extra) as { error: string }).error : 'read').toMatch(/holds \d+ block rows; its head lists \d+/)
    // A head written without the list (the format before this review): not read.
    const bare = rows.map((x) => (x.chunk === HEAD_CHUNK ? { ...x, body: JSON.stringify((({ blocks: _b, entries: _e, ...rest }) => rest)(JSON.parse(x.body) as Record<string, unknown>)) } : x))
    expect('error' in readAnomalyRows(bare) ? (readAnomalyRows(bare) as { error: string }).error : 'read').toBe('anomaly_state head does not list its blocks')
    // A list naming absurdly many blocks is refused without expanding it.
    const huge = rows.map((x) => (x.chunk === HEAD_CHUNK ? { ...x, body: x.body.replace(/"blocks":\[\[\d+,\d+\]\]/, '"blocks":[[0,9007199254740000]]') } : x))
    expect('error' in readAnomalyRows(huge)).toBe(true)
  })

  it('incremental writes keep the list exact: tick after tick, with series pruned and blocks deleted, the rows always read back', () => {
    const rule = parsedRule()
    let rt = newAnomalyRt(rule)
    const rows = new Map<number, string>()
    let ts = 1.8e12 + 23_456
    for (let i = 0; i < 400; i++) {
      ts += MIN * (i % 97 === 96 ? 70 : 1)
      const series = ['a', 'b'].filter((s) => !(s === 'b' && i % 200 > 120)).map((s) => ({ metric: { service: s }, value: 100 + (i % 9), text: String(100 + (i % 9)) }))
      const ev = evalAnomaly(rule, rt, series, ts, MIN, LIMITS_M12, {}, true, 2)
      if (!ev.ok) throw new Error(ev.error)
      if (ev.changed && ev.write) {
        if (ev.write.purge) rows.clear()
        for (const u of ev.write.upserts) rows.set(u.chunk, u.body)
        for (const c of ev.write.deletes) rows.delete(c)
        rt = { ...rt, series: ev.next, json: ev.json, store: ev.write.store, status: ev.status, pruned: ev.status.pruned }
      }
      const read = readAnomalyRows([...rows].map(([chunk, body]) => ({ chunk, body })))
      if ('error' in read) throw new Error(`tick ${i}: ${read.error}`)
    }
  })

  it('through the Ruler object: a block row deleted, or cut to one series, leaves the rule state_unreadable with its rows kept as they are', async () => {
    for (const harm of ['missing', 'partial'] as const) {
      const T = await setup({ heartbeatMs: 30 * MIN }, newTenant(`m12${harm}`))
      T.w.anomalyStateWrite = 2
      ok(await T.stub.saveGroups(T.tenant, { groups: [{ name: 'anomalies/1m', interval: '1m', rules: [{ alert: 'R', expr: LAT, anomaly: { detector: 'robust_z', params: { windowPoints: 150, minPoints: 5 }, max_series: 5 } }] }] }))
      let i = 0
      T.w.evaluate = (q) => (q === LAT ? vec([{ service: 'a' }, 100 + ((i * 37) % 7)], [{ service: 'b' }, 50 + ((i++ * 11) % 5)]) : vec())
      for (let k = 0; k < 130; k++) await tick(T.stub, T.tenant)
      const before = await rowsOf(T.stub, T.tenant)
      const blocks = before.filter((r) => r.chunk > HEAD_CHUNK + 1e6)
      expect(blocks.length, harm).toBeGreaterThanOrEqual(3)
      const victim = blocks[1]!
      await runInDurableObject(T.stub, (_i, s) => {
        if (harm === 'missing') s.storage.sql.exec('DELETE FROM anomaly_state WHERE tenant = ? AND rule_key = ? AND chunk = ?', T.tenant, victim.rule_key, victim.chunk)
        else {
          const body = JSON.parse(victim.body) as { series: unknown[] }
          s.storage.sql.exec('UPDATE anomaly_state SET body = ? WHERE tenant = ? AND rule_key = ? AND chunk = ?', JSON.stringify({ ...body, series: body.series.slice(0, 1) }), T.tenant, victim.rule_key, victim.chunk)
        }
      })
      const harmed = await rowsOf(T.stub, T.tenant)
      await evictDurableObject(T.stub)
      for (let k = 0; k < 3; k++) await tick(T.stub, T.tenant)
      const st = ok(await T.stub.rules(T.tenant)).rules[0]!
      expect([st.health, st.anomaly!.status], harm).toEqual(['err', 'state_unreadable'])
      expect(st.lastError, harm).toMatch(harm === 'missing' ? /^state_unreadable: anomaly_state is missing block row \d+ that its head lists/ : /^state_unreadable: anomaly_state blocks hold \d+ series entries; its head counts \d+/)
      expect(await rowsOf(T.stub, T.tenant), harm).toEqual(harmed)
    }
  }, 300_000)
})

const LIMITS_M12 = anomalyLimits({ ...DEFAULT_RULER_CONFIG, limits: { ...DEFAULT_RULER_CONFIG.limits, maxAnomalyStateBytesPerRule: 16_000_000, maxAnomalyStateBytesPerObject: 64_000_000 } })
function parsedRule(): AnomalyRuleV2 {
  const p = parseRuleFile({ groups: [{ name: 'g', interval: '1m', rules: [{ alert: 'A', expr: LAT, anomaly: { detector: 'robust_z', params: { windowPoints: 200, minPoints: 5 }, max_series: 4 } }] }] }, DEFAULT_RULER_CONFIG)
  if (p.errors.length > 0) throw new Error(JSON.stringify(p.errors))
  return p.groups[0]!.anomalyRules![0] as AnomalyRuleV2
}
