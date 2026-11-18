import { evictDurableObject } from 'cloudflare:test'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Alert, AlertingRule } from '../contracts-proposal/rules'
import { compileAlertRule, ruleKey } from '../src/rules'
import { evalAlertingRule, type Series } from '../src/statemachine'
import { fingerprint } from '../src/util'
import { alarmAt, alertsOf, MIN, nextTick, ok, setup, sqlWrites, vec } from './helpers'

/**
 * REFERENCE MODEL, written from the Prometheus documentation of alert states and NOT from
 * `src/statemachine.ts`: one explicit state machine per series, driven by "is the series in
 * the result at this evaluation". The implementation under test is a transcription of
 * upstream's two-pass loop over a map; this is a per-series transition table.
 */
type Ref =
  | { phase: 'pending'; activeAt: number }
  | { phase: 'firing'; activeAt: number; firedAt: number; holdSince: number | null }
  | { phase: 'resolved'; activeAt: number; firedAt: number; holdSince: number | null; resolvedAt: number }

interface Params {
  forMs: number
  keepMs: number
  retentionMs: number
}

function refStep(st: Ref | undefined, present: boolean, ts: number, p: Params): Ref | undefined {
  const fresh = (): Ref => (p.forMs === 0 ? { phase: 'firing', activeAt: ts, firedAt: ts, holdSince: null } : { phase: 'pending', activeAt: ts })
  if (st === undefined) return present ? fresh() : undefined
  switch (st.phase) {
    case 'pending':
      if (!present) return undefined // a pending alert whose condition clears is forgotten
      return ts - st.activeAt >= p.forMs ? { phase: 'firing', activeAt: st.activeAt, firedAt: ts, holdSince: null } : st
    case 'firing': {
      if (present) return st.holdSince === null ? st : { ...st, holdSince: null }
      if (p.keepMs > 0) {
        const holdSince = st.holdSince ?? ts
        if (ts - holdSince < p.keepMs) return { ...st, holdSince }
        return { ...st, phase: 'resolved', holdSince, resolvedAt: ts }
      }
      return { ...st, phase: 'resolved', resolvedAt: ts }
    }
    case 'resolved':
      if (present) return fresh() // a new incident
      return ts - st.resolvedAt > p.retentionMs ? undefined : st
  }
}

/** The reference state in the vocabulary of the implementation's `Alert`. */
const view = (st: Ref) => ({
  state: st.phase === 'resolved' ? 'inactive' : st.phase,
  activeAt: st.activeAt,
  firedAt: st.phase === 'pending' ? null : st.firedAt,
  resolvedAt: st.phase === 'resolved' ? st.resolvedAt : null,
  keepFiringSince: st.phase === 'pending' ? null : st.holdSince,
})
const viewAlert = (a: Alert) => ({ state: a.state, activeAt: a.activeAt, firedAt: a.firedAt, resolvedAt: a.resolvedAt, keepFiringSince: a.keepFiringSince })

const UNIVERSE = ['a', 'b', 'c', 'd']
const paramsArb = fc.record({
  forMs: fc.constantFrom(0, MIN, 2 * MIN, 5 * MIN),
  keepMs: fc.constantFrom(0, MIN, 3 * MIN),
  retentionMs: fc.constantFrom(0, 2 * MIN, 15 * MIN),
})
/** Each step: how many intervals passed (1 = on time; more = missed ticks) and which series the query returned. */
const stepsArb = fc.array(fc.record({ gap: fc.constantFrom(1, 1, 1, 1, 2, 3, 7), present: fc.subarray(UNIVERSE) }), { minLength: 1, maxLength: 40 })

const mkRule = (p: Params): AlertingRule => ({
  kind: 'alert', name: 'P', expr: 'x', forMs: p.forMs, keepFiringForMs: p.keepMs, labels: {}, annotations: { v: '{{ $value }}' },
  key: ruleKey('alert', 'P', 'x', {}), cost: { class: 'tail', windowMs: 0, reason: '' },
})
const fpOf = (i: string) => fingerprint({ instance: i, alertname: 'P' })
const seriesOf = (present: string[], value: number): Series[] => present.map((i) => ({ metric: { __name__: 'm', instance: i }, value, text: String(value) }))

describe('property: the state machine equals the reference model', () => {
  it('for random result sequences, parameters and missed ticks: same states, same notifications, and exactly one dirty alert per reference transition', () => {
    fc.assert(
      fc.property(paramsArb, stepsArb, (p, steps) => {
        const rule = mkRule(p)
        const compiled = compileAlertRule(rule)
        let alerts: ReadonlyMap<string, Alert> = new Map()
        const ref = new Map<string, Ref>()
        let ts = 0
        steps.forEach((step, n) => {
          ts += step.gap * MIN
          const r = evalAlertingRule(rule, compiled, alerts, seriesOf(step.present, n), ts, { resolvedRetentionMs: p.retentionMs, limit: 0, maxAnnotationBytes: 4096, externalLabels: {} })
          if (!r.ok) throw new Error(r.error)
          const changed: string[] = []
          const wantNotify: string[] = []
          for (const i of UNIVERSE) {
            const before = ref.get(i)
            const after = refStep(before, step.present.includes(i), ts, p)
            if (after === undefined) ref.delete(i)
            else ref.set(i, after)
            if (JSON.stringify(before) !== JSON.stringify(after)) changed.push(fpOf(i))
            if (after?.phase === 'firing' && before?.phase !== 'firing') wantNotify.push(`${fpOf(i)}:firing`)
            if (before?.phase === 'firing' && after?.phase !== 'firing') wantNotify.push(`${fpOf(i)}:resolved`)
          }
          const got = Object.fromEntries([...r.alerts].map(([fp, a]) => [fp, viewAlert(a)]))
          const want = Object.fromEntries([...ref].map(([i, st]) => [fpOf(i), view(st)]))
          expect(got).toEqual(want)
          expect(r.notify.map((x) => `${x.fingerprint}:${x.status}`).sort()).toEqual(wantNotify.sort())
          // Persisted rows change exactly where the reference made a transition: no write
          // for a steady alert, however its value moves.
          expect([...r.dirty].sort()).toEqual(changed.sort())
          // The previous map is never mutated (it is what storage still holds until commit).
          alerts = r.alerts
        })
      }),
      { numRuns: 1500 },
    )
  })

  it('evaluating the same (state, result, time) twice gives the same result and no second transition', () => {
    fc.assert(
      fc.property(paramsArb, stepsArb, (p, steps) => {
        const rule = mkRule(p)
        const compiled = compileAlertRule(rule)
        const opts = { resolvedRetentionMs: p.retentionMs, limit: 0, maxAnnotationBytes: 4096, externalLabels: {} }
        let alerts: ReadonlyMap<string, Alert> = new Map()
        let ts = 0
        steps.forEach((step, n) => {
          ts += step.gap * MIN
          const frozen = JSON.stringify([...alerts])
          const once = evalAlertingRule(rule, compiled, alerts, seriesOf(step.present, n), ts, opts)
          expect(JSON.stringify([...alerts])).toBe(frozen)
          if (!once.ok) throw new Error(once.error)
          // Replay on the committed state: nothing left to do.
          const again = evalAlertingRule(rule, compiled, once.alerts, seriesOf(step.present, n), ts, opts)
          if (!again.ok) throw new Error(again.error)
          expect([...again.alerts]).toEqual([...once.alerts])
          expect(again.notify).toEqual([])
          expect(again.dirty.size).toBe(0)
          alerts = once.alerts
        })
      }),
      { numRuns: 500 },
    )
  })
})

describe('property: the Ruler object against the reference model, counting SQL writes', () => {
  it('states match after every tick (with evictions), and rows written = transitions + hand-off rows + heartbeats', async () => {
    const HEARTBEAT = 10 * MIN
    await fc.assert(
      fc.asyncProperty(
        paramsArb.filter((p) => p.retentionMs === 15 * MIN),
        fc.array(fc.record({ gap: fc.constantFrom(1, 1, 1, 2, 4), present: fc.subarray(UNIVERSE), evict: fc.boolean() }), { minLength: 5, maxLength: 25 }),
        async (p, steps) => {
          const { tenant, stub, w } = await setup({ heartbeatMs: HEARTBEAT })
          let present: string[] = []
          let value = 0
          w.evaluate = () => vec(...present.map((i): [Record<string, string>, number] => [{ __name__: 'm', instance: i }, value]))
          const dur = (ms: number) => `${ms / 1000}s`
          ok(await stub.saveGroups(tenant, { groups: [{ name: 'g', interval: '1m', rules: [{ alert: 'P', expr: 'x', for: dur(p.forMs), keep_firing_for: dur(p.keepMs), annotations: { v: '{{ $value }}' } }] }] }))
          const first = await nextTick(stub, tenant) // empty result; writes the first heartbeat
          let lastHeartbeat = first
          const ref = new Map<string, Ref>()
          let ts = first
          let written = 0
          let expected = 0
          for (const [n, step] of steps.entries()) {
            ts += step.gap * MIN
            present = step.present
            value = n + 1
            let transitions = 0
            let notified = false
            for (const i of UNIVERSE) {
              const before = ref.get(i)
              const after = refStep(before, present.includes(i), ts, p)
              if (after === undefined) ref.delete(i)
              else ref.set(i, after)
              if (JSON.stringify(before) !== JSON.stringify(after)) transitions++
              if ((after?.phase === 'firing') !== (before?.phase === 'firing')) notified = true
            }
            if (step.evict) await evictDurableObject(stub)
            const before = await sqlWrites(stub, tenant)
            await alarmAt(stub, ts)
            written += (await sqlWrites(stub, tenant)) - before
            // one row per transition; one hand-off row inserted and one deleted when the
            // notifier accepted it; one heartbeat row per heartbeat period
            expected += transitions + (notified ? 2 : 0)
            if (ts - lastHeartbeat >= HEARTBEAT) {
              expected += 1
              lastHeartbeat = ts
            }
            const got = Object.fromEntries((await alertsOf(stub, tenant)).map((a) => [a.labels.instance, viewAlert(a)]))
            const want = Object.fromEntries([...ref].map(([i, st]) => [i, view(st)]))
            expect(got).toEqual(want)
          }
          expect(written).toBe(expected)
          const h = ok(await stub.health(tenant))
          expect(h.outboxDepth).toBe(0)
          expect(h.groups[0]!.lastEvaluationMs).toBe(ts)
        },
      ),
      { numRuns: 40 },
    )
  })
})
