import { describe, expect, it } from 'vitest'
import { createMockApi } from '../../mock/handler'
import { PromClient } from '../api/client'
import { getMonitor, listMonitors, type Monitor } from '../api/monitors'
import { fixedZone } from '../lib/timeInput'
import { historyLines, isShare, listText, mayAct, monitorText, monitorUnit, parseMonitorsSearch, plain, ReadGuard, renderMessage, sentence, sortMonitors, stateWords, thresholdWords, undoOpen, unitValue, valueWords, when } from './model'

const client = () => new PromClient({ fetch: createMockApi({ now: () => Date.UTC(2026, 10, 28, 9, 30) / 1000 }).fetch })
const NOW = Date.UTC(2026, 10, 28, 9, 30)

describe('monitors, as the views say them (monitors/model.ts)', () => {
  it('the list is attention first: firing that nobody has, then the handled, then no data, error, pending, then the quiet', async () => {
    const list = await listMonitors(client(), 'all')
    const sorted = sortMonitors(list.monitors).map((m) => `${m.state}${m.acknowledged || m.silencedUntil ? '+' : ''}`)
    expect(sorted).toEqual(['firing', 'firing+', 'no_data', 'error', 'pending', 'ok', 'ok'])
  })

  it('every state has a mark and words: never colour alone, and the words say what it is', async () => {
    const list = await listMonitors(client(), 'all')
    const seen = new Map<string, string>()
    const states: Monitor['state'][] = ['firing', 'pending', 'no_data', 'error', 'ok', 'unknown', 'warming']
    for (const state of states) {
      const m = { ...list.monitors[0]!, state, acknowledged: null, silencedUntil: null }
      const w = stateWords(m, NOW)
      expect(plain(w).length, state).toBeGreaterThan(5)
      seen.set(state, plain(w).replace(/[\d:]/g, ''))
    }
    // Two states never read the same once their colour is taken away.
    expect(new Set(seen.values()).size).toBe(states.length)
    // Someone's acknowledgement takes the neutral mark and the row says both facts.
    const firing = list.monitors.find((m) => m.name === 'Checkout 5xx ratio')!
    const acked = { ...firing, acknowledged: { by: 'key:dana', at: NOW } }
    expect(stateWords(acked, NOW).mark).toBe('ack')
    expect(plain(stateWords(acked, NOW))).toMatch(/^Acknowledged, firing since \d\d:\d\d$/)
    // On the monitor's own page the state line keeps its words: who and when is said once, beside the action.
    expect(plain(stateWords(acked, NOW, true))).toMatch(/^Firing since \d\d:\d\d \(\d+ (h|min)/)
    expect(stateWords({ ...firing, silencedUntil: NOW + 3_600_000 }, NOW).mark).toBe('silenced')
    expect(stateWords(firing, NOW).mark).toBe('critical')
  })

  it('one event has one time: clock time today, the date another day, to the minute', () => {
    const z = fixedZone(60)
    expect(when(Date.UTC(2026, 10, 28, 12, 7, 41), Date.UTC(2026, 10, 28, 13, 0), z)).toBe('13:07')
    expect(when(Date.UTC(2026, 10, 27, 12, 7), Date.UTC(2026, 10, 28, 13, 0), z)).toBe('27 Nov 13:07')
    expect(when(Date.UTC(2025, 10, 27, 12, 7), Date.UTC(2026, 10, 28, 13, 0), z)).toBe('27 Nov 2025 13:07')
  })

  it('the history is newest first, in sentences with who did what; the text form carries the head\'s facts', async () => {
    const c = client()
    const firing = (await listMonitors(c, 'all')).monitors.find((m) => m.name === 'Catalog p99 latency')!
    const doc = await getMonitor(c, firing.id)
    const lines = historyLines(doc, 'key:lee')
    expect(lines[0]!.sentence).toMatch(/^Silenced by you until /)
    expect(lines[1]!.sentence).toBe('Acknowledged by you. Repeats stop until it resolves.')
    expect(lines.at(-1)!.sentence).toBe('Created by you.')
    expect(lines.map((l) => l.at)).toEqual([...lines.map((l) => l.at)].sort((a, b) => b - a))
    const text = monitorText(doc, 'key:lee', NOW, 'Acknowledged by you at 08:41')
    expect(text.split('\n')[0]).toMatch(/^Catalog p99 latency\. Firing since \d\d:\d\d \(\d+ min\)\. Acknowledged by you at 08:41\.$/)
    expect(text).toContain('Threshold: > 80 ms for 5 min.')
    expect(text).toContain('Notifies catalog-team (Slack #catalog)')
    expect(listText([firing], 'silenced', 7, NOW)).toMatch(/^1 of 7 monitors are silenced\.\nCatalog p99 latency: Silenced until \d\d:\d\d, firing since \d\d:\d\d\./)
  })

  it('who may act: the key\'s scopes when the API has said them, and nobody is refused before the API has', () => {
    expect(mayAct(['read', 'monitors:read', 'monitors:ack'])).toBe(true)
    expect(mayAct(['read', 'monitors:read'])).toBe(false)
    expect(mayAct([])).toBe(false)
    expect(mayAct(null)).toBe(null)
  })

  it('an undo is open only for its own monitor and only before the API\'s undoUntil, by the API\'s clock', () => {
    const u = { monitor: 'mon_a', token: 't', undoUntil: 1_060_000, until: 4_600_000, skewMs: 5_000 }
    // This tab's clock is 5 s behind the API's.
    expect(undoOpen(u, 'mon_a', 1_054_999)).toBe(true)
    expect(undoOpen(u, 'mon_a', 1_055_000)).toBe(false)
    expect(undoOpen(u, 'mon_b', 1_000_000)).toBe(false)
    expect(undoOpen(null, 'mon_a', 0)).toBe(false)
  })

  it('a read that started before a write began or ended is not painted; the read after it is', () => {
    const g = new ReadGuard()
    const before = g.stamp()
    g.bump() // the write starts
    const during = g.stamp()
    g.bump() // the write is answered
    const after = g.stamp()
    expect([g.current(before), g.current(during), g.current(after)]).toEqual([false, false, true])
  })

  it('the address: an id the API could have given, a filter (attention is the default and left out), a range', () => {
    expect(parseMonitorsSearch({ id: 'mon_0123456789abcdef', filter: 'all', from: 'now-6h', to: 'now' })).toEqual({ id: 'mon_0123456789abcdef', filter: 'all', from: 'now-6h', to: 'now' })
    expect(parseMonitorsSearch({ id: '../x', filter: 'attention', from: 'yesterday' })).toEqual({})
  })

  it('a monitor\'s values carry its unit (M-M2): the condition\'s, else the message template\'s, else a share from the query, else Explore\'s guess', () => {
    const base = { condition: { op: '>', threshold: 0.02 }, message: '', query: null, expr: 'up' } as const
    const ratio = 'sum(rate(http_requests_total{service="checkout",status="500"}[5m])) / sum(rate(http_requests_total{service="checkout"}[5m]))'
    expect(isShare(ratio)).toBe(true)
    expect(isShare('sum(rate(a_total[5m])) / sum(rate(b_total[5m]))')).toBe(false)
    expect(isShare('sum(rate(http_requests_total{route="/a/b"}[5m]))')).toBe(false)
    expect(monitorUnit({ ...base, query: ratio })).toBe('percentunit')
    expect(monitorUnit({ ...base, message: 'Checkout is failing {{ $value | humanizePercentage }} of requests' })).toBe('percentunit')
    expect(monitorUnit({ ...base, condition: { op: '>', threshold: 0.25, unit: 's' } })).toBe('seconds')
    expect(monitorUnit({ ...base, query: 'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))' })).toBe('seconds')
    const m = { ...base, query: ratio, forMs: 300_000, thresholdText: '> 0.02 for 5m' }
    expect(valueWords(0.0837, m)).toBe('8.4%')
    expect(thresholdWords(m)).toBe('> 2% for 5 min')
    expect(thresholdWords(m, false)).toBe('> 2%')
    expect(unitValue(0.231, 'seconds')).toBe('231 ms')
    expect(unitValue(3 * 1024 ** 3, 'bytes')).toBe('3 GiB')
    expect(unitValue(0.0004, 'percentunit')).toBe('0.04%')
  })

  it('a message template is shown as it was sent, or as the template it is (o2); the API\'s words read as a sentence (o5)', () => {
    expect(renderMessage('Checkout is failing {{ $value | humanizePercentage }} of requests', 0.0412, {})).toBe('Checkout is failing 4.1% of requests')
    expect(renderMessage('{{ $labels.service }} is slow: {{ $value | humanizeDuration }}', 0.4, { service: 'catalog' })).toBe('catalog is slow: 400 ms')
    expect(renderMessage('{{ range $x }}', 1, {})).toBeNull()
    expect(sentence('the ruler did not answer in time; nothing was changed')).toBe('The ruler did not answer in time; nothing was changed.')
  })
})

