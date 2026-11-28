import { describe, expect, it } from 'vitest'
import { createMockApi } from '../../mock/handler'
import { PromClient } from './client'
import { getMonitor, listMonitors, RulerApiError, setAcknowledged, silenceMonitor, undoSilence } from './monitors'

const KEY = 'viz_oncallKey000000000_secretSecret'
const READER = 'viz_monReadKey00000000_secretSecret'

/** A client on the mock that records every request it sends. */
function recorded(token = KEY) {
  const api = createMockApi({ requireToken: 'viz_readKey00000000000_secretSecret', monitorsToken: READER, oncallToken: KEY })
  const sent: { url: string; method: string; body: string; headers: Record<string, string> }[] = []
  const client = new PromClient({
    token,
    fetch: async (input, init) => {
      const headers: Record<string, string> = {}
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
      sent.push({ url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : '', headers })
      return api.fetch(input, init)
    },
  })
  return { client, sent }
}

describe('the monitors client (api/monitors.ts)', () => {
  it('the key goes in the Authorization header of every request, and in no URL or body; dryRun is never sent', async () => {
    const { client, sent } = recorded()
    const list = await listMonitors(client, 'attention')
    const firing = list.monitors.find((m) => m.name === 'Checkout 5xx ratio')!
    await getMonitor(client, firing.id)
    await setAcknowledged(client, firing.id, true)
    await setAcknowledged(client, firing.id, false)
    const s = await silenceMonitor(client, firing.id, '15m')
    await undoSilence(client, s.undoToken!)
    expect(sent).toHaveLength(6)
    for (const r of sent) {
      expect(r.headers.authorization).toBe(`Bearer ${KEY}`)
      expect(r.url).not.toContain(KEY)
      expect(r.url).not.toContain('secretSecret')
      expect(r.body).not.toContain('secretSecret')
      expect(r.url + r.body).not.toMatch(/dryRun/i)
    }
    expect(sent.map((r) => `${r.method} ${new URL(r.url, 'http://x').pathname}`)).toEqual([
      'GET /api/v1/monitors',
      `GET /api/v1/monitors/${firing.id}`,
      `POST /api/v1/monitors/${firing.id}/acknowledge`,
      `POST /api/v1/monitors/${firing.id}/unacknowledge`,
      `POST /api/v1/monitors/${firing.id}/silence`,
      'POST /api/v1/monitors/silences/undo',
    ])
    expect(JSON.parse(sent[4]!.body)).toEqual({ duration: '15m' })
    expect(JSON.parse(sent[5]!.body)).toEqual({ undoToken: s.undoToken })
  })

  it('reads the answers: who and when of an acknowledgement, the undo token with its window and when the silence ends', async () => {
    const { client } = recorded()
    const firing = (await listMonitors(client, 'attention')).monitors.find((m) => m.name === 'Checkout 5xx ratio')!
    const ack = await setAcknowledged(client, firing.id, true)
    expect(ack.by).toBe('key:on-call key')
    expect(ack.fingerprints).toEqual([firing.alerts[0]!.fingerprint])
    const s = await silenceMonitor(client, firing.id, '1h')
    expect(s.undoToken).toMatch(/^[0-9a-f]{32}$/)
    expect(s.undoUntil! - Date.now()).toBeGreaterThan(55_000)
    expect(s.until! - Date.now()).toBeGreaterThan(3_590_000)
  })

  it('a refusal is a RulerApiError with the ruler\'s code, words and status', async () => {
    const { client } = recorded(READER)
    const firing = (await listMonitors(client, 'attention')).monitors.find((m) => m.state === 'firing')!
    const e = await setAcknowledged(client, firing.id, true).catch((x) => x)
    expect(e).toBeInstanceOf(RulerApiError)
    expect([e.errorType, e.status, e.message]).toEqual(['forbidden', 403, 'API key lacks the monitors:ack scope'])
    const gone = await undoSilence(client, 'ffffffffffffffffffffffffffffffff').catch((x) => x)
    expect([gone.errorType, gone.status]).toEqual(['forbidden', 403])
    const { client: oncall } = recorded()
    const missing = await getMonitor(oncall, 'mon_0000000000000000').catch((x) => x)
    expect([missing.errorType, missing.status, missing.message]).toEqual(['not_found', 404, 'monitor mon_0000000000000000 not found'])
  })
})
