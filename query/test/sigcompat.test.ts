/**
 * Tempo and Loki compatibility points of the review of signals end to end (m-4): Loki's
 * timestamps (an integer of ten or fewer digits is seconds, as its v2.8 reference states), Loki's
 * errors as plain text, and Tempo's `/api/echo`.
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import query from '../src/index'
import { lokiTime } from '../src/sigparams'
import { api, world } from './world'

describe('Loki timestamps', () => {
  it('ten or fewer digits are seconds, more are nanoseconds; floats are seconds; RFC 3339', () => {
    expect(lokiTime('start', '1795078800')).toBe(1_795_078_800_000_000_000n)
    expect(lokiTime('start', '0')).toBe(0n)
    expect(lokiTime('start', '9223372036')).toBe(9_223_372_036_000_000_000n)
    // Ten digits of seconds past what an i64 of nanoseconds holds (2262): refused, not wrapped.
    expect(() => lokiTime('start', '9999999999')).toThrow(/within the times storage holds/)
    // Eleven digits and more: nanoseconds (as before).
    expect(lokiTime('start', '10000000000')).toBe(10_000_000_000n)
    expect(lokiTime('start', '1795078800000000000')).toBe(1_795_078_800_000_000_000n)
    expect(lokiTime('start', '1795078800.5')).toBe(1_795_078_800_500_000_000n)
    expect(lokiTime('start', '2026-11-19T09:00:00Z')).toBe(1_795_078_800_000_000_000n)
    expect(() => lokiTime('start', '-1')).toThrow(/within the times storage holds/)
  })

  it('a query sent with seconds reads the same range as one sent with nanoseconds', async () => {
    const w = await world()
    const ns = await api(w.a.key, '/loki/api/v1/labels', [['start', '1795078800000000000'], ['end', '1795082400000000000']])
    const s = await api(w.a.key, '/loki/api/v1/labels', [['start', '1795078800'], ['end', '1795082400']])
    expect([s.status, await s.text()]).toEqual([ns.status, await ns.text()])
  })
})

describe('error bodies', () => {
  it('Loki answers errors as plain text with the status, Tempo too; Prometheus keeps its envelope', async () => {
    const w = await world()
    const loki = await api(w.a.key, '/loki/api/v1/query_range', [['query', '{job=']])
    expect([loki.status, loki.headers.get('Content-Type')?.startsWith('text/plain'), (await loki.text()).startsWith('{')]).toEqual([400, true, false])
    const tempo = await api(w.a.key, '/api/search', [['q', '{ nonsense']])
    expect([tempo.status, tempo.headers.get('Content-Type')?.startsWith('text/plain')]).toEqual([400, true])
    const prom = await api(w.a.key, '/api/v1/query', [['query', 'up{']])
    expect([prom.status, ((await prom.json()) as { status: string }).status]).toEqual([400, 'error'])
  })
})

describe("Tempo's echo", () => {
  it('answers `echo` with a key, 401 without one, 404 with the flag off', async () => {
    const w = await world()
    const res = await api(w.a.key, '/api/echo')
    expect([res.status, res.headers.get('Content-Type'), await res.text()]).toEqual([200, 'text/plain; charset=utf-8', 'echo'])
    expect((await api(null, '/api/echo')).status).toBe(401)
    const off = await query.fetch(new Request('https://viz.test/api/echo', { headers: { Authorization: `Bearer ${w.a.key}` } }), { ...env, QUERY_SIGNALS: 'logs' } as never)
    expect(off.status).toBe(404)
  })
})
