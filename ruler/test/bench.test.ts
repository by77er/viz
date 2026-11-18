/**
 * Measurements, in workerd, of the ruler's own overhead. The evaluator is the in-process
 * fake (it answers from a table), so these numbers exclude all query cost.
 * `npm run bench` prints them; they are recorded in README.md as "measured here".
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { world } from './harness'
import { alertsOf, MIN, ok, setup, vec } from './helpers'

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!
  return { min: s[0]!, median: q(0.5), p95: q(0.95), max: s[s.length - 1]! }
}
const fmt = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')

describe('measurements', () => {
  for (const shape of [{ groups: 1, perGroup: 1000 }, { groups: 10, perGroup: 100 }]) {
    it(`1,000 rules as ${shape.groups} group(s) of ${shape.perGroup}, 100 firing alerts`, async () => {
      const { tenant, stub, w } = await setup({ heartbeatMs: 5 * MIN, maxConcurrentGroups: 4 })
      // 950 alerting rules and 50 recording rules. 100 alerting rules each have one firing
      // alert; the others return three healthy series that match nothing... i.e. an empty vector.
      const firing = vec([{ __name__: 'errors_total', job: 'api', instance: 'web-1:9100', region: 'eu-west-1' }, 12.5])
      const recorded = vec(...Array.from({ length: 5 }, (_, i): [Record<string, string>, number] => [{ job: `job-${i}`, region: 'eu-west-1' }, i]))
      const empty = vec()
      w.evaluate = (q) => (q.startsWith('firing') ? firing : q.startsWith('sum') ? recorded : empty)
      const rule = (g: number, i: number) => {
        const n = g * shape.perGroup + i
        if (n % 20 === 19) return { record: `job:requests:rate5m_${n}`, expr: `sum by (job, region) (rate(http_requests_total{shard="${n}"}[5m]))` }
        return {
          alert: `HighErrorRate${n}`,
          expr: `${n % 10 === 0 ? 'firing' : 'quiet'}_expr{shard="${n}"} / ignoring (code) rate(http_requests_total{shard="${n}"}[5m]) > 0.05`,
          for: '2m',
          labels: { severity: n % 3 === 0 ? 'page' : 'ticket', team: `team-${n % 7}` },
          annotations: {
            summary: 'High error rate on {{ $labels.instance }} ({{ $value | humanizePercentage }})',
            description: 'Job {{ $labels.job }} in {{ $labels.region }} has had an error ratio of {{ printf "%.3f" $value }} for 2 minutes.',
            runbook_url: 'https://runbooks.example.test/high-error-rate',
          },
        }
      }
      const groups = Array.from({ length: shape.groups }, (_, g) => ({ name: `group-${g}`, interval: '1m', rules: Array.from({ length: shape.perGroup }, (_, i) => rule(g, i)) }))
      const t0 = performance.now()
      const saved = ok(await stub.saveGroups(tenant, { groups }))
      const saveMs = performance.now() - t0
      expect(saved.groups.flatMap((g) => g.rules).length).toBe(1000)

      const start = Math.max(...saved.groups.map((g) => g.nextEvaluationMs))
      const tickOnce = async (at: number) => {
        world.now = at
        const before = ok(await stub.health(tenant)).counters
        const t = performance.now()
        expect(await runDurableObjectAlarm(stub)).toBe(true)
        const ms = performance.now() - t
        const after = ok(await stub.health(tenant)).counters
        return { ms, rows: after.sqlRowsWritten - before.sqlRowsWritten, alarms: after.alarmsSet - before.alarmsSet }
      }
      // Warm-up and transitions: pending at the first tick, firing two minutes later.
      const transitions = [await tickOnce(start), await tickOnce(start + MIN), await tickOnce(start + 2 * MIN)]
      expect((await alertsOf(stub, tenant)).filter((a) => a.state === 'firing').length).toBe(100)

      // Steady state: every group due at each alarm (the clock sits just after the last offset).
      const steady = []
      for (let k = 3; k < 43; k++) steady.push(await tickOnce(start + k * MIN))
      const rowsPerTick = steady.map((s) => s.rows)
      const heartbeats = rowsPerTick.filter((r) => r > 0).length
      const wall = stats(steady.map((s) => s.ms))
      const size = await runInDurableObject(stub, (_i, state) => state.storage.sql.databaseSize)
      const tEvict = performance.now()
      await evictDurableObject(stub)
      ok(await stub.health(tenant))
      const reloadMs = performance.now() - tEvict
      const evalCalls = w.evalCalls.length / 43

      console.log(
        [
          `[bench] 1,000 rules = ${shape.groups} x ${shape.perGroup}; 100 firing alerts; fake evaluator`,
          `[bench]   save 1,000 rules (validate, classify, store): ${saveMs.toFixed(1)} ms`,
          `[bench]   tick wall time, steady state, 40 ticks: ${fmt(wall)} ms  (${evalCalls.toFixed(0)} evaluator calls per tick)`,
          `[bench]   tick wall time with transitions (100 pending / none / 100 firing): ${transitions.map((t) => t.ms.toFixed(1)).join(' / ')} ms; rows ${transitions.map((t) => t.rows).join(' / ')}`,
          `[bench]   SQL rows written per steady tick: ${Math.min(...rowsPerTick)} (${heartbeats} of 40 ticks wrote the 1 heartbeat row); setAlarm calls per tick: ${stats(steady.map((s) => s.alarms)).max}`,
          `[bench]   storage: ${size} bytes (${(size / 1024).toFixed(0)} KiB) for 1,000 rules and 100 firing alerts`,
          `[bench]   evict + rebuild from SQLite + first RPC: ${reloadMs.toFixed(1)} ms`,
        ].join('\n'),
      )
      expect(rowsPerTick.filter((r) => r === 0).length).toBe(40 - heartbeats)
      expect(Math.max(...rowsPerTick)).toBeLessThanOrEqual(1 + 2) // heartbeat row (+ nothing else in steady state)
      expect(heartbeats).toBe(8) // 40 minutes / 5-minute heartbeat
    })
  }
})
