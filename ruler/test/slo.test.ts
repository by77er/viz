/**
 * SLO burn-rate rules (contract version 4). What is checked here:
 *
 * - detection: on simulated 1-minute buckets the page and ticket alerts fire within one bucket of
 *   the SRE Workbook's detection time, `(1 - SLO) / error ratio × window × burn rate`
 *   (`anomaly/` `ruleDetectionTimeMs`), for the error ratios of the library's table, and never
 *   where the formula says never; and at every point they agree with the library's own
 *   incremental detector (`burnRate.detect`) on the same buckets, sentence included; the
 *   threshold is strict (`>`, as the workbook's expressions);
 * - the sentence: which windows burned, how fast, how much budget is left over the compliance
 *   window and how long it lasts at this rate, with the numbers in `slo_detail`;
 * - in the Ruler object: ONE query per SLO rule per tick in the group's batch, alerts by severity
 *   through the notifier, state as rows (head and current blocks) that survive eviction and
 *   replays, refusals that change nothing, a newer release's rows kept, and every statement on
 *   SLO state naming the tenant.
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { burnRate, fmt, duration, ruleDetectionTimeMs, SRE_WORKBOOK_RULES } from '../../anomaly/src/index.ts'
import type { PromMatrix } from '../../contracts/engine'
import type { SloDetail, SloRuleV2 } from '../contracts-proposal/rules.v2'
import { parseRuleFile } from '../src/rules'
import { DEFAULT_RULER_CONFIG } from '../src/ruler'
import { coarseExpr, warmSlo } from '../src/history'
import { evalSlo, newSloRt, readSloRows, roughDuration, sloGeometry, type SloRow, type SloRt } from '../src/slo'
import { toSeries, type Series } from '../src/statemachine'
import { Crash, FREE_PLAN, T0, tenantWorld, world } from './harness'
import { MIN, notifierStub, ok, rulerStub, runNotifierUntil, setup, vec } from './helpers'

const HOUR = 60 * MIN
const DAY = 24 * HOUR
export const SLI = { bad: 'sum(increase(errors_total[$window]))', total: 'sum(increase(requests_total[$window]))' }
export const sloEntry = (slo: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ alert: 'CheckoutSLO', ...extra, slo: { objective: 0.999, sli: SLI, ...slo } })

/** The rule as the ruler stores it. */
function parsed(slo: Record<string, unknown> = {}, interval = '1m'): SloRuleV2 {
  const p = parseRuleFile({ groups: [{ name: 'g', interval, rules: [sloEntry(slo)] }] }, DEFAULT_RULER_CONFIG)
  expect(p.errors).toEqual([])
  return p.groups[0]!.sloRules![0] as SloRuleV2
}

/** The per-tick expression's result: total and bad events of one bucket, as the engine returns them. */
export function parts(total: number, bad: number | null, labels: Record<string, string> = {}): Series[] {
  const out: Series[] = [{ metric: { ...labels, viz_slo_part: 'total' }, value: total, text: String(total) }]
  if (bad !== null) out.push({ metric: { ...labels, viz_slo_part: 'bad' }, value: bad, text: String(bad) })
  return out
}

const at = (i: number) => T0 + i * MIN

/** Good history for the longest window (3 days at 1 minute: windows fully covered), then `bad(i)` of N per bucket. */
function simulate(rule: SloRuleV2, rt: SloRt, bad: (i: number) => number, steps: number, N = 1000, history = 4320) {
  for (let i = -history; i < 0; i++) expect(evalSlo(rule, rt, parts(N, 0), at(i), MIN, i === -1).ok).toBe(true)
  const out: { i: number; flagged: (Series & { annotations: Record<string, string> })[] }[] = []
  for (let i = 0; i < steps; i++) {
    const ev = evalSlo(rule, rt, parts(N, bad(i)), at(i), MIN)
    if (!ev.ok) throw new Error(ev.error)
    out.push({ i, flagged: ev.flagged })
  }
  return out
}

describe('detection against the SRE Workbook (99.9% over 30 days, the four default alerts, 1-minute buckets)', () => {
  // The error ratios of anomaly/README.md's table. Values are whole numbers of events, so every sum is exact.
  const RATIOS = [1, 0.1, 0.02, 0.01, 0.005, 0.002, 0.001]
  for (const e of RATIOS) {
    it(`error ratio ${e}: page and ticket fire within one bucket of the formula's time, or never where it says never`, () => {
      const rule = parsed()
      const expect_ = (sev: 'page' | 'ticket') => Math.min(...SRE_WORKBOOK_RULES.filter((r) => r.severity === sev).map((r) => ruleDetectionTimeMs(e, 0.999, r)))
      const want = { page: expect_('page'), ticket: expect_('ticket') }
      const horizon = Math.ceil(Math.min(3 * DAY, Math.max(...Object.values(want).filter(Number.isFinite), 60 * MIN) + 10 * MIN) / MIN)
      const run = simulate(rule, newSloRt(rule), () => e * 1000, horizon)
      for (const sev of ['page', 'ticket'] as const) {
        const first = run.find((s) => s.flagged.some((f) => f.metric.severity === sev))
        if (!Number.isFinite(want[sev])) {
          expect(first, `${sev} never fires at ${e}`).toBeUndefined()
          continue
        }
        // Detection time: the end of the bucket that tipped it, counted from the start of the errors.
        const detectedMs = (first!.i + 1) * MIN
        expect(detectedMs, `${sev} at ${e}: formula ${want[sev] / MIN} min`).toBeGreaterThanOrEqual(want[sev])
        expect(detectedMs, `${sev} at ${e}: formula ${want[sev] / MIN} min`).toBeLessThanOrEqual(want[sev] + MIN)
      }
    })
  }

  it('the table the library reproduces: first page at 1, 9, 44 minutes for 100%, 10%, 2%; the 6-hour page at 217 minutes for 1%; tickets at 865 and 2,161 minutes for 0.5% and 0.2%', () => {
    const first = (e: number, sev: string, horizon: number) => {
      const rule = parsed()
      const run = simulate(rule, newSloRt(rule), () => e * 1000, horizon)
      const s = run.find((x) => x.flagged.some((f) => f.metric.severity === sev))
      return s ? s.i + 1 : null
    }
    expect([first(1, 'page', 5), first(0.1, 'page', 15), first(0.02, 'page', 50), first(0.01, 'page', 230)]).toEqual([1, 9, 44, 217])
    expect([first(0.005, 'ticket', 900), first(0.002, 'ticket', 2200)]).toEqual([865, 2161])
  })

  it('at every point the alerts equal the library\'s own detector (burnRate.detect) on the same buckets, and the sentence starts with its explanation', () => {
    const rule = parsed()
    // Bursts of errors of different sizes, quiet stretches between them: page, ticket, both, neither.
    const bad = (i: number) => (i % 997 < 6 ? 400 : i % 613 < 90 ? 9 : i % 401 < 20 ? 30 : (i * 7) % 5)
    const steps = 3000
    const run = simulate(rule, newSloRt(rule), bad, steps)
    const ts: number[] = []
    const b: number[] = []
    const t: number[] = []
    for (let i = -4320; i < steps; i++) {
      ts.push(at(i))
      b.push(i < 0 ? 0 : bad(i))
      t.push(1000)
    }
    const lib = burnRate.detect({ ts: Float64Array.from(ts), values: Float64Array.from(b), total: Float64Array.from(t) }, { objective: 0.999, periodMs: 30 * DAY, rules: SRE_WORKBOOK_RULES, minEvents: 0, stepMs: MIN, minCoverage: 0.9 }, null)
    let pages = 0
    let tickets = 0
    for (const s of run) {
      const p = lib.points[4320 + s.i]!
      const sev = new Set(s.flagged.map((f) => f.metric.severity))
      expect(sev.size > 0, `point ${s.i}`).toBe(p.anomalous)
      if (!p.anomalous) continue
      // The library reports the most urgent firing rule: page if any page rule fires.
      const best = p.explanation!.facts.severity
      expect(best === 'page', `point ${s.i}`).toBe(sev.has('page'))
      const mine = s.flagged.find((f) => f.metric.severity === best)!
      expect(mine.annotations.slo!.startsWith(`${p.explanation!.text}; `), `point ${s.i}`).toBe(true)
      if (sev.has('page')) pages++
      if (sev.has('ticket')) tickets++
    }
    expect(pages, 'the bursts page').toBeGreaterThan(10)
    expect(tickets, 'and ticket').toBeGreaterThan(10)
  })

  it('the threshold is strict: a burn rate exactly at it does not fire, just above it does (exactly representable numbers)', () => {
    // Objective 0.5: a budget of exactly one half. 6 bad of 8 is a burn rate of exactly 1.5.
    const rule = parsed({ objective: 0.5, window: '1h', alerts: [{ severity: 'page', long_window: '4m', short_window: '2m', burn_rate: 1.5 }], min_coverage: 0 })
    const fires = (badEvents: number) => {
      const rt = newSloRt(rule)
      let flagged = 0
      for (let i = 0; i < 8; i++) {
        const ev = evalSlo(rule, rt, parts(8, badEvents), at(i), MIN)
        if (!ev.ok) throw new Error(ev.error)
        flagged += ev.flagged.length
      }
      return flagged > 0
    }
    expect(fires(6)).toBe(false)
    expect(fires(7)).toBe(true)
  })

  it('a window counts only once min_coverage of its buckets have data: a new rule without history does not page on its first bad minute', () => {
    const rule = parsed()
    const rt = newSloRt(rule)
    const ev = evalSlo(rule, rt, parts(1000, 1000), at(0), MIN)
    expect(ev.ok && ev.flagged).toEqual([])
    expect(ev.ok && ev.status).toMatchObject({ status: 'warming', warming: 1, message: expect.stringMatching(/^1 of 1 series warming: the 1 hour window has 1.67% of its buckets \(needs 90%\)/) })
  })
})

describe('the sentence: which windows burned, how fast, how much budget is left', () => {
  it('says the burn rates and thresholds, the budget left over the compliance window and how long it lasts at this rate; every number is in slo_detail', () => {
    const rule = parsed()
    const rt = newSloRt(rule)
    const N = 1000
    const g = sloGeometry(rule.slo, MIN)
    // 30 days of buckets: 600 bad events on day 5, then one minute of total outage.
    const days = 30 * 24 * 60
    for (let i = -days; i < 0; i++) {
      const b = i >= -days + 5 * 1440 && i < -days + 5 * 1440 + 600 ? 1 : 0
      expect(evalSlo(rule, rt, parts(N, b), at(i), MIN, false).ok).toBe(true)
    }
    const ev = evalSlo(rule, rt, parts(N, N), at(0), MIN)
    if (!ev.ok) throw new Error(ev.error)
    const page = ev.flagged.find((f) => f.metric.severity === 'page')!
    const d = JSON.parse(page.annotations.slo_detail!) as SloDetail
    // Independently: the coarse ring ends at the hour holding this minute and holds the 719 hours before it.
    const n = at(0) / MIN
    const m = g.coarseMs / MIN
    const k = Math.ceil(n / m)
    const buckets = n - (k - g.coarseBuckets) * m
    const remaining = 1 - (600 + N) / (buckets * N) / (1 - 0.999)
    const longBurn = N / (60 * N) / (1 - 0.999)
    const shortBurn = N / (5 * N) / (1 - 0.999)
    expect(d).toMatchObject({ v: 1, severity: 'page', longWindowMs: HOUR, shortWindowMs: 5 * MIN, threshold: 14.4, objective: 0.999, windowMs: 30 * DAY, budgetCoveredMs: 30 * DAY, at: at(0) })
    expect(d.longBurnRate).toBeCloseTo(longBurn, 9)
    expect(d.shortBurnRate).toBeCloseTo(shortBurn, 9)
    expect(d.budgetRemaining!).toBeCloseTo(remaining, 12)
    expect(d.spentInLongWindow).toBeCloseTo((longBurn * HOUR) / (30 * DAY), 12)
    expect(d.exhaustionMs!).toBe(Math.round((remaining * 30 * DAY) / longBurn))
    expect(page.annotations.slo).toBe(
      `error budget burning at ${fmt(longBurn)}× over 1 hour and ${fmt(shortBurn)}× over 5 minutes (page threshold 14.4×); ` +
        `${fmt(100 * longBurn * HOUR / (30 * DAY))}% of the 30 days budget for a 99.9% objective was spent in the last 1 hour; ` +
        `${fmt(100 * remaining)}% of the budget is left over the last 30 days, spent in ${roughDuration(d.exhaustionMs!)} at this rate`,
    )
    expect(page.annotations.slo).toMatch(/96\.3% of the budget is left over the last 30 days, spent in 1\.73 days at this rate$/)
    expect(page.value).toBe(Math.min(longBurn, shortBurn))
    expect(page.annotations.description, 'no description was written: the sentence is the description').toBe(page.annotations.slo)
  })

  it('with less history than the window it says how much it covers; an overspent budget says so', () => {
    const rule = parsed({ min_coverage: 0 })
    const rt = newSloRt(rule)
    for (let i = 0; i < 120; i++) evalSlo(rule, rt, parts(100, i < 119 ? 0 : 100), at(i), MIN)
    const ev = evalSlo(rule, rt, parts(100, 100), at(120), MIN)
    const text = ev.ok ? ev.flagged.find((f) => f.metric.severity === 'page')!.annotations.slo! : ''
    // 121 one-minute buckets with data: what the budget figure covers, however the hours fall.
    expect(text).toMatch(/; the budget is spent over the 121 minutes on record \(the window is 30 days\) \(-[\d.]+% left\)$/)
  })
})

// ───────────────────────────── in the Ruler object ─────────────────────────────

/** A tenant with one SLO rule (and anything else in `extra`), its history and live buckets scripted. */
async function rig(opts: { slo?: Record<string, unknown>; extra?: unknown[]; bad?: (i: number) => number; total?: number; batch?: boolean; tenant?: string; labels?: (i: number) => Record<string, string>[] } = {}) {
  const { tenant, stub, w } = await setup({ heartbeatMs: 6 * HOUR }, opts.tenant)
  w.batch = opts.batch ?? false
  const total = opts.total ?? 1000
  const series = opts.labels ?? (() => [{}])
  /** Query times of live ticks, in order: index i is the i-th evaluation. */
  const times: number[] = []
  const live = (t: number) => {
    if (!times.includes(t)) times.push(t)
    return times.indexOf(t)
  }
  w.evaluate = (q, t) => {
    if (!q.includes('viz_slo_part')) return vec()
    const i = live(t)
    const out: [Record<string, string>, number][] = []
    for (const l of series(i)) {
      out.push([{ ...l, viz_slo_part: 'total' }, total])
      out.push([{ ...l, viz_slo_part: 'bad' }, (opts.bad ?? (() => 0))(i)])
    }
    return vec(...out)
  }
  // History: good traffic, at the read's own bucket width (one hour for the coarse read).
  w.range = (q, start, end, step): PromMatrix => {
    const width = q.includes('[1h]') ? 60 : 1
    const labels = series(0)
    const values = (n: number): [number, string][] => {
      const v: [number, string][] = []
      for (let x = start; x <= end; x += step) v.push([x / 1000, String(n)])
      return v
    }
    return { resultType: 'matrix', result: labels.flatMap((l) => [{ metric: { ...l, viz_slo_part: 'total' }, values: values(total * width) }, { metric: { ...l, viz_slo_part: 'bad' }, values: values(0) }]) }
  }
  const saved = ok(await stub.saveGroups(tenant, { groups: [{ name: 'slos/1m', interval: '1m', rules: [...(opts.extra ?? []), sloEntry(opts.slo)] }] }))
  return {
    tenant,
    stub,
    w,
    saved,
    times,
    tick: async () => {
      world.now = Math.max(world.now, ok(await stub.health(tenant)).alarmAtMs!)
      expect(await runDurableObjectAlarm(stub)).toBe(true)
      return world.now
    },
    rule: async () => ok(await stub.rules(tenant)).rules.find((x) => x.name === 'CheckoutSLO')!,
    rows: () => runInDurableObject(stub, (_i, s) => s.storage.sql.exec('SELECT tenant, grp, rule_key, part, block, body FROM slo_state ORDER BY tenant, grp, rule_key, part, block').toArray()),
    writes: async () => ok(await stub.health(tenant)).counters.sqlRowsWritten,
    /**
     * The object's stored state, decoded, against a reference run in this test: the same warm-up
     * reads and the same buckets at the same query times, through the pure functions, without
     * evictions, replays or crashes.
     */
    reference: async () => {
      const rule = ok(await stub.listGroups(tenant)).groups[0]!.sloRules![0] as SloRuleV2
      // The warm-up's reads as its status records them; the reference reads them whole, in one window.
      const status = ok(await stub.rules(tenant)).rules.find((x) => x.name === 'CheckoutSLO')!.slo!.warmup!
      const fine = { promql: rule.expr, ...status.reads.find((x) => x.stepMs === MIN)! }
      const c = status.reads.find((x) => x.stepMs !== MIN)
      const coarse = c ? { promql: coarseExpr(rule, c.stepMs), ...c } : null
      const io = { planner: { plan: async () => FREE_PLAN }, range: { range: async (q: string, s0: number, e: number, st: number) => w.range!(q, s0, e, st) as PromMatrix }, budget: { scanSamples: Infinity, bytesToRead: Infinity }, memoryBytes: 1 << 30 }
      const warm = await warmSlo(rule, MIN, fine, coarse, io)
      if (!warm.ok) throw new Error(JSON.stringify(warm))
      for (const t of times) {
        const ev = evalSlo(rule, warm.value, toSeries((await w.evaluate(rule.expr, t)) as never), t, MIN)
        if (!ev.ok) throw new Error(ev.error)
      }
      const rows = (await runInDurableObject(stub, (_i, s) => s.storage.sql.exec('SELECT part, block, body FROM slo_state WHERE tenant = ?', tenant).toArray())) as unknown as SloRow[]
      const stored = readSloRows(rule, MIN, rows)
      if ('error' in stored) throw new Error(stored.error)
      return { stored: decode(stored.rt), reference: decode(warm.value) }
    },
  }
}

/** A rule's state as plain data: the counters, and per series its last outcome and the buckets each ring holds. */
function decode(rt: SloRt) {
  const ring = (r: { size: number; get(s: number): [number, number] }, last: number | null) => {
    if (last === null) return []
    const out: (number | null)[] = []
    for (let s = last - r.size + 1; s <= last; s++) {
      const [b, t] = r.get(s)
      out.push(b === b ? b : null, t === t ? t : null)
    }
    return out
  }
  return {
    origin: rt.origin,
    lastSlot: rt.lastSlot,
    lastCoarse: rt.lastCoarse,
    lastTs: rt.lastTs,
    series: [...rt.series.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, s]) => ({ k, labels: s.labels, last: s.last, seenAt: s.seenAt, fine: ring(s.fine, rt.lastSlot), coarse: ring(s.coarse, rt.lastCoarse) })),
  }
}

describe('in the Ruler object', () => {
  it('one query per SLO rule per tick, in the group\'s one batch call; the page fires on the first bad minute and the ticket on the fifth, each routed by severity with the sentence', async () => {
    const r = await rig({ batch: true, extra: [{ alert: 'Up', expr: 'up == 0' }], bad: (i) => (i >= 2 && i < 7 ? 1000 : 0) })
    const notifier = notifierStub(r.tenant)
    ok(await notifier.setConfig(r.tenant, {
      route: { receiver: 'tickets', group_by: ['alertname', 'severity'], group_wait: '0s', group_interval: '1m', repeat_interval: '4h', routes: [{ match: { severity: 'page' }, receiver: 'pager' }] },
      receivers: [{ name: 'tickets', webhook_configs: [{ url: 'https://tickets.test/hook' }] }, { name: 'pager', webhook_configs: [{ url: 'https://pager.test/hook' }] }],
    }))
    const states: { i: number; page: string | null; ticket: string | null }[] = []
    for (let i = 0; i < 40; i++) {
      await r.tick()
      await runNotifierUntil(notifier, r.tenant, world.now)
      const alerts = (await r.rule()).alerts
      states.push({ i, page: alerts.find((a) => a.labels.severity === 'page')?.state ?? null, ticket: alerts.find((a) => a.labels.severity === 'ticket')?.state ?? null })
    }
    // ONE batch call per tick, with the alerting rule's expression and the SLO's one expression.
    expect(r.w.batchCalls).toHaveLength(40)
    for (const call of r.w.batchCalls) expect(call.map((q) => q.promql)).toEqual(['up == 0', 'label_replace(sum(increase(requests_total[1m])), "viz_slo_part", "total", "", "") or label_replace(sum(increase(errors_total[1m])), "viz_slo_part", "bad", "", "")'])
    // Five minutes of total outage from the third: page after 1 bucket (formula 51.8 s), ticket after 5
    // (4.32 min); the page holds while the 6 h / 30 m alert burns (5,000 bad events of 30,000 in its
    // short window) and resolves when the outage leaves that window, 30 minutes after it ended.
    expect(states.find((s) => s.page === 'firing')!.i).toBe(2)
    expect(states.find((s) => s.ticket === 'firing')!.i).toBe(6)
    expect(states.find((s) => s.i > 2 && s.page !== 'firing')!.i).toBe(36)
    const pages = r.w.received.filter((x) => x.url.startsWith('https://pager.test'))
    const tickets = r.w.received.filter((x) => x.url.startsWith('https://tickets.test'))
    type Body = { status: string; alerts: { status: string; labels: Record<string, string>; annotations: Record<string, string> }[] }
    const firstPage = (pages[0]!.body as Body).alerts[0]!
    expect(firstPage.labels).toMatchObject({ alertname: 'CheckoutSLO', severity: 'page' })
    expect(firstPage.annotations.slo).toMatch(/^error budget burning at 16\.7× over 1 hour and 200× over 5 minutes \(page threshold 14\.4×\); 2\.31% of the 30 days budget for a 99\.9% objective was spent in the last 1 hour; 97\.7% of the budget is left over the last 30 days, spent in [\d.]+ days at this rate$/)
    expect(JSON.parse(firstPage.annotations.slo_detail!)).toMatchObject({ v: 1, severity: 'page', threshold: 14.4, budgetCoveredMs: 30 * DAY })
    expect((tickets[0]!.body as Body).alerts[0]!.labels).toMatchObject({ alertname: 'CheckoutSLO', severity: 'ticket' })
    // The page resolves once the short window cools; it was sent once firing and once resolved.
    expect(pages.flatMap((p) => (p.body as Body).alerts.map((a) => a.status))).toEqual(['firing', 'resolved'])
    expect((await r.rule()).slo).toMatchObject({ status: 'ok', series: 1, stateSeries: 1, burning: { page: 0 }, warmup: { status: 'done' } })
  })

  it('state is rows: the head and the current block of each ring, three rows a steady tick; with evictions and replays the stored state is exactly a run without them', async () => {
    const r = await rig({ bad: (i) => (i >= 5 && i < 9 ? 600 : i % 3) })
    await r.tick()
    const written: number[] = []
    for (let i = 1; i < 40; i++) {
      const states = async () => JSON.stringify((await r.rule()).alerts.map((x) => [x.fingerprint, x.state]))
      const before = [await r.writes(), await states()] as const
      await r.tick()
      // A tick in which no alert changed writes the rings only.
      if ((await states()) === before[1]) written.push((await r.writes()) - before[0])
      if (i % 3 === 0) await evictDurableObject(r.stub)
      if (i % 4 === 0) {
        // The same tick again, after an eviction: nothing may advance twice.
        await r.rule()
        await evictDurableObject(r.stub)
        await runInDurableObject(r.stub, (inst) => inst.alarm())
      }
    }
    // Three rows (head, fine block, coarse block); a fourth when a block leaves a ring and is deleted.
    expect(written.length).toBeGreaterThan(20)
    expect(written.every((n) => n === 3 || n === 4), JSON.stringify(written)).toBe(true)
    expect(written.filter((n) => n === 3).length).toBeGreaterThan(written.length * 0.9)
    const { stored, reference } = await r.reference()
    expect(stored).toEqual(reference)
    expect(stored.series[0]!.last!.page, 'it paged during the run').toBeNull()
    expect((await r.rule()).alerts.some((a) => a.labels.severity === 'page'), 'a page alert was raised (and resolved)').toBe(true)
    // Bounded: the head, the blocks of the 3-day ring (one more while one leaves), the same for the 30-day ring.
    const rule = ok(await r.stub.listGroups(r.tenant)).groups[0]!.sloRules![0] as SloRuleV2
    const g = sloGeometry(rule.slo, MIN)
    expect((await r.rows()).length).toBeLessThanOrEqual(1 + g.fineSize / 60 + 1 + g.coarseSize / 24 + 1)
  })

  it('a crash inside the commit transaction persists neither the alerts nor the rings; the retry gives what a run without the crash gives', async () => {
    const r = await rig({ bad: (i) => (i === 4 ? 1000 : 0) })
    for (let i = 0; i < 4; i++) await r.tick()
    const before = await r.rows()
    r.w.faults.add('ruler:commit')
    world.now = Math.max(world.now, ok(await r.stub.health(r.tenant)).alarmAtMs!)
    const crashed = await runInDurableObject(r.stub, (inst) => inst.alarm()).then(() => 'ok', (e) => (e instanceof Crash || /injected crash/.test(String(e)) ? 'crashed' : String(e)))
    expect(crashed).toBe('crashed')
    expect(await r.rows()).toEqual(before)
    expect((await r.rule()).alerts).toEqual([])
    await evictDurableObject(r.stub)
    expect(await runDurableObjectAlarm(r.stub)).toBe(true)
    const { stored, reference } = await r.reference()
    expect(stored).toEqual(reference)
    expect((await r.rule()).alerts.map((x) => [x.labels.severity, x.state])).toEqual([['page', 'firing']])
  })

  it('refusals change nothing: more series than max_series, parts that do not pair up; a newer release\'s rows are refused, kept, and carried by a shard move', async () => {
    let mode: 'ok' | 'many' | 'unpaired' = 'ok'
    const r = await rig({ bad: (i) => (i >= 3 ? 1000 : 0), labels: () => (mode === 'many' ? Array.from({ length: 11 }, (_x, k) => ({ pod: `p${k}` })) : [{ pod: 'p0' }]) })
    for (let i = 0; i < 5; i++) await r.tick()
    expect((await r.rule()).alerts.map((a) => a.state)).toContain('firing')
    const before = { rows: await r.rows(), alerts: (await r.rule()).alerts }
    mode = 'many'
    await r.tick()
    let s = await r.rule()
    expect([s.health, s.slo!.status, s.lastError]).toEqual(['err', 'series_cap_exceeded', expect.stringMatching(/^series_cap_exceeded: the SLI returned 11 series; this rule evaluates at most 10/)])
    expect({ rows: await r.rows(), alerts: s.alerts }).toEqual(before)
    mode = 'unpaired'
    const base = r.w.evaluate
    r.w.evaluate = (q, t) => (q.includes('viz_slo_part') ? vec([{ pod: 'p0', viz_slo_part: 'total' }, 10], [{ pod: 'p1', viz_slo_part: 'bad' }, 1]) : base(q, t))
    await r.tick()
    s = await r.rule()
    expect([s.health, s.slo!.status, s.lastError]).toEqual(['err', 'invalid_result', expect.stringMatching(/^invalid_result: the bad expression returned a series the total expression did not .*aggregate both by the same labels/)])
    expect({ rows: await r.rows(), alerts: s.alerts }).toEqual(before)

    // A newer release's rows: refused, kept, no alert resolved.
    r.w.evaluate = base
    mode = 'ok'
    const key = r.saved.groups[0]!.rules[0]!.key
    const newer = JSON.stringify({ v: 2, rings: 'a format from the future' })
    await runInDurableObject(r.stub, (_i, st) => {
      st.storage.sql.exec('DELETE FROM slo_state WHERE tenant = ?', r.tenant)
      st.storage.sql.exec('INSERT INTO slo_state (tenant, grp, rule_key, part, block, body) VALUES (?, ?, ?, ?, 0, ?)', r.tenant, 'slos/1m', key, 'head', newer)
    })
    await evictDurableObject(r.stub)
    // Alerts as stored (a steady alert's value is refreshed in memory only, so compare after the reload).
    const stored = (await r.rule()).alerts
    expect(stored.map((a) => [a.fingerprint, a.state])).toEqual(before.alerts.map((a) => [a.fingerprint, a.state]))
    const handed = r.w.ingestCalls.length
    await r.tick()
    s = await r.rule()
    expect([s.health, s.slo!.status]).toEqual(['err', 'state_unreadable'])
    expect(s.lastError).toMatch(/^state_unreadable: slo_state row version 2 is not 1/)
    expect(s.alerts).toEqual(stored)
    expect(r.w.ingestCalls.length).toBe(handed)
    expect((await r.rows()).map((x) => x.body)).toEqual([newer])
    // A save of the group (the rule kept, with no warm-up job, as a rule an earlier release saved
    // has none) must not warm the rule over the newer release's rows.
    await runInDurableObject(r.stub, (_i, st) => void st.storage.sql.exec('DELETE FROM warmup WHERE tenant = ?', r.tenant))
    await evictDurableObject(r.stub)
    ok(await r.stub.saveGroups(r.tenant, { groups: [{ name: 'slos/1m', interval: '1m', rules: [sloEntry()] }] }))
    await r.tick()
    expect((await r.rows()).map((x) => x.body)).toEqual([newer])
    expect((await r.rule()).slo!.status).toBe('state_unreadable')
    const bundle = ok(await r.stub.exportGroup(r.tenant, 'slos/1m')).bundle
    expect(bundle.sloState).toEqual({ [key]: [{ part: 'head', block: 0, body: newer }] })
    const target = rulerStub(r.tenant, '1')
    ok(await target.configure(r.tenant, { deadman: false, heartbeatMs: 6 * HOUR }))
    ok(await target.importGroup(r.tenant, bundle))
    expect(ok(await target.rules(r.tenant)).rules[0]!.slo!.status).toBe('state_unreadable')
    expect(await runInDurableObject(target, (_i, st) => st.storage.sql.exec('SELECT body FROM slo_state WHERE tenant = ?', r.tenant).toArray().map((x) => x.body))).toEqual([newer])
  })

  it('a shard move carries the rings and the warm-up status: the moved rule keeps evaluating where it was and is not warmed again', async () => {
    const r = await rig({ bad: (i) => (i >= 3 ? 1000 : 0) })
    for (let i = 0; i < 4; i++) await r.tick()
    const bundle = ok(await r.stub.exportGroup(r.tenant, 'slos/1m')).bundle
    const target = rulerStub(r.tenant, '1')
    ok(await target.configure(r.tenant, { deadman: false, heartbeatMs: 6 * HOUR }))
    ok(await target.importGroup(r.tenant, bundle))
    const moved = ok(await target.rules(r.tenant)).rules[0]!
    expect(moved.slo).toMatchObject({ stateSeries: 1, warmup: { status: 'done' } })
    const plans = r.w.planCalls.length
    world.now = Math.max(world.now, ok(await target.health(r.tenant)).alarmAtMs!)
    expect(await runDurableObjectAlarm(target)).toBe(true)
    expect(r.w.planCalls.length, 'no second warm-up').toBe(plans)
    expect(ok(await target.rules(r.tenant)).rules[0]!.slo).toMatchObject({ status: 'ok', budgetCoveredMs: 30 * DAY })
  })

  it('every statement on SLO state names the tenant: another tenant\'s rows in the same storage are neither loaded nor touched', async () => {
    const r = await rig()
    for (let i = 0; i < 3; i++) await r.tick()
    const key = r.saved.groups[0]!.rules[0]!.key
    const mine = await r.rows()
    const head = mine.find((x) => x.part === 'head')!
    // The other tenant's head: the same group, rule key, part and block, holding two series of its own.
    const two = '"series":[{"k":"eeeeeeeeeeeeeeee","l":{"pod":"yy"},"last":null,"seen":1},{"k":"ffffffffffffffff","l":{"pod":"zz"},"last":null,"seen":1}]}'
    const foreign = { tenant: 'someone-else', grp: 'slos/1m', rule_key: key, part: 'head', block: 0, body: (head.body as string).replace(/"series":\[.*\]\}$/, two) }
    // And a block of the other tenant at this tenant's current block, for this tenant's own series key: loaded, it would overwrite buckets.
    const fine = mine.filter((x) => x.part === 'fine').at(-1)!
    const k = (JSON.parse(head.body as string) as { series: { k: string }[] }).series[0]!.k
    const block = { tenant: 'someone-else', grp: 'slos/1m', rule_key: key, part: 'fine', block: fine.block as number, body: JSON.stringify({ v: 1, series: [{ k, b: Array(60).fill(999), t: Array(60).fill(1000) }] }) }
    await runInDurableObject(r.stub, (_i, s) => {
      for (const f of [foreign, block]) s.storage.sql.exec('INSERT INTO slo_state (tenant, grp, rule_key, part, block, body) VALUES (?, ?, ?, ?, ?, ?)', f.tenant, f.grp, f.rule_key, f.part, f.block, f.body)
    })
    await evictDurableObject(r.stub)
    expect((await r.rule()).slo!.stateSeries, 'loaded: this tenant\'s one series only').toBe(1)
    await r.tick()
    // What it stored after the tick is exactly what the same buckets give without the foreign row.
    const { stored, reference } = await r.reference()
    expect(stored).toEqual(reference)
    expect((await r.rows()).filter((x) => x.tenant === 'someone-else')).toEqual([block, foreign])
    ok(await r.stub.deleteGroup(r.tenant, 'slos/1m'))
    expect(await r.rows()).toEqual([block, foreign])
    expect(await runInDurableObject(r.stub, (_i, s) => s.storage.sql.exec('SELECT COUNT(*) AS n FROM warmup WHERE tenant = ?', r.tenant).one().n)).toBe(0)
  })
})

describe('validation', () => {
  it('problems come back with a path and a fix; defaults are written out; the save answers what the rule reads', async () => {
    const { tenant, stub } = await setup()
    const save = (slo: Record<string, unknown>, extra: Record<string, unknown> = {}) => stub.checkGroups(tenant, { groups: [{ name: 'g', interval: '1m', rules: [{ alert: 'S', ...extra, slo }] }] })
    const errs = async (slo: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const r = await save(slo, extra)
      return r.status === 'invalid' ? r.errors.map((e) => [e.path, e.message]) : []
    }
    expect(await errs({ objective: 99.9, sli: SLI })).toEqual([['groups[0].rules[0].slo.objective', 'objective must be a fraction between 0 and 1 (exclusive)']])
    expect((await save({ objective: 99.9, sli: SLI })).status === 'invalid' && (await save({ objective: 99.9, sli: SLI }) as { errors: { fix: string }[] }).errors[0]!.fix).toBe('Write 99.9% as 0.999.')
    expect(await errs({ objective: 0.99, sli: { bad: 'sum(rate(errors_total[5m]))', total: SLI.total } })).toEqual([['groups[0].rules[0].slo.sli.bad', 'bad must read one bucket: write its range as [$window]']])
    expect(await errs({ objective: 0.99, sli: { good: SLI.bad, bad: SLI.bad, total: SLI.total } })).toEqual([['groups[0].rules[0].slo.sli', 'give exactly good and total (found good, bad, total)']])
    expect(await errs({ objective: 0.99, sli: SLI }, { expr: 'up' })).toEqual([['groups[0].rules[0].expr', 'an SLO rule has no expr: the SLI in slo.sli is its expression']])
    expect(await errs({ objective: 0.99, sli: SLI }, { labels: { severity: 'page' } })).toEqual([['groups[0].rules[0].labels.severity', 'an SLO rule sets severity itself: page or ticket, from the burn-rate alert that fires']])
    expect(await errs({ objective: 0.99, sli: SLI, alerts: [{ severity: 'page', long_window: '5m', short_window: '1h', burn_rate: 2 }] })).toEqual([['groups[0].rules[0].slo.alerts[0].short_window', 'short_window must be shorter than long_window']])
    expect(await errs({ objective: 0.99, sli: SLI, max_series: 500 })).toEqual([['groups[0].rules[0].slo.max_series', 'max_series 500 is above this ruler\'s limit of 100']])
    const ok90 = await save({ objective: 0.9, sli: SLI })
    expect(ok90.status === 'ok' && ok90.warnings.map((w) => w.message)).toEqual([expect.stringMatching(/^at objective 0.9, a burn rate of 14.4× needs an error ratio above 1.44, which cannot happen: this alert never fires/)])
    const saved = ok(await stub.saveGroups(tenant, { groups: [{ name: 'g', interval: '1m', rules: [{ alert: 'S', slo: { objective: 0.999, sli: SLI } }] }] }))
    expect(saved.groups[0]!.rules[0]).toMatchObject({ kind: 'slo', cost: { class: 'tail' }, slo: { tick: 'tail', coldStart: 'rollup', lookbackMs: 4320 * MIN, bucketMs: MIN, budgetLookbackMs: 30 * DAY, budgetBucketMs: HOUR } })
    const stored = ok(await stub.listGroups(tenant)).groups[0]!.sloRules![0] as SloRuleV2
    expect(stored.slo).toMatchObject({ objective: 0.999, windowMs: 30 * DAY, minEvents: 0, minCoverage: 0.9, maxSeries: 10, given: ['objective', 'sli'], alerts: SRE_WORKBOOK_RULES.map((x) => ({ ...x })) })
  })
})
