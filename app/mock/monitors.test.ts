import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createMockApi } from './handler'

/**
 * The mock's monitors API against the ruler's own description of it (ruler/openapi.json): every
 * answer the mock gives in these tests is validated against the operation's response schema for
 * its status, by a small validator of the JSON Schema the file uses (type, enum, required,
 * properties, items, additionalProperties, oneOf, $ref). The real ruler is not run here; this
 * is the contract the mock is held to instead (README, "Monitors": the real ruler was not
 * compared).
 */
type Schema = Record<string, unknown>
const SPEC = JSON.parse(readFileSync(new URL('../../ruler/openapi.json', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, { responses: Record<string, Schema> }>>; components: Record<string, Record<string, Schema>> }

function deref(s: Schema): Schema {
  let cur = s
  while (typeof cur.$ref === 'string') {
    const [, , kind, name] = (cur.$ref as string).split('/')
    cur = SPEC.components[kind!]![name!]!
  }
  return cur
}
const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v)
/** Problems of `v` against `schema`, with their paths; empty when it conforms. */
export function validateSchema(schema: Schema, v: unknown, path = '$'): string[] {
  const s = deref(schema)
  if (Array.isArray(s.oneOf)) {
    const ok = (s.oneOf as Schema[]).filter((o) => validateSchema(o, v, path).length === 0).length
    return ok === 1 ? [] : [`${path}: matches ${ok} of oneOf`]
  }
  const out: string[] = []
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string]
    const t = typeOf(v)
    if (!types.includes(t) && !(t === 'integer' && types.includes('number'))) return [`${path}: ${t} is not ${types.join('|')}`]
  }
  if (Array.isArray(s.enum) && !(s.enum as unknown[]).includes(v)) out.push(`${path}: ${JSON.stringify(v)} is not one of ${JSON.stringify(s.enum)}`)
  if (typeOf(v) === 'object') {
    const o = v as Record<string, unknown>
    for (const r of (s.required as string[] | undefined) ?? []) if (!(r in o)) out.push(`${path}: ${r} is required`)
    const props = (s.properties as Record<string, Schema> | undefined) ?? {}
    for (const [k, x] of Object.entries(o)) {
      if (props[k]) out.push(...validateSchema(props[k]!, x, `${path}.${k}`))
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') out.push(...validateSchema(s.additionalProperties as Schema, x, `${path}.${k}`))
    }
  }
  if (typeOf(v) === 'array' && s.items) (v as unknown[]).forEach((x, i) => out.push(...validateSchema(s.items as Schema, x, `${path}[${i}]`)))
  return out
}

const ON_CALL = 'viz_oncallKey000000000_secretSecret'
const READER = 'viz_monReadKey00000000_secretSecret'
const READ_ONLY = 'viz_readKey00000000000_secretSecret'
const OPTS = { requireToken: READ_ONLY, monitorsToken: READER, oncallToken: ON_CALL }

/** One mock, as the server keeps it for its life; each call's answer is checked against the operation it is for. */
function mock(now = Date.UTC(2026, 10, 28, 9, 30) / 1000) {
  let t = now
  const api = createMockApi({ ...OPTS, now: () => t })
  const checked: string[] = []
  const call = (method: string, path: string, body?: unknown, token: string | null = ON_CALL, op?: string) => {
    const r = api.handle(method, path, body === undefined ? '' : JSON.stringify(body), token ? { authorization: `Bearer ${token}` } : {})
    const template = op ?? path.split('?')[0]!.replace(/\/mon_[0-9a-f]{16}/, '/{id}')
    const operation = SPEC.paths[template]?.[method.toLowerCase()]
    expect(operation, `${method} ${template} is in ruler/openapi.json`).toBeDefined()
    const response = operation!.responses[String(r.status)]
    expect(response, `${method} ${template} ${r.status} is a documented answer`).toBeDefined()
    const schema = (deref(response!).content as Record<string, { schema: Schema }> | undefined)?.['application/json']?.schema
    expect(schema, `${method} ${template} ${r.status} has a JSON schema`).toBeDefined()
    expect(validateSchema(schema!, r.body), `${method} ${path} -> ${r.status}`).toEqual([])
    checked.push(`${method} ${template} ${r.status}`)
    return { status: r.status, body: r.body as Record<string, any>, headers: r.headers ?? {} }
  }
  return { call, checked, advance: (ms: number) => (t += ms / 1000), api }
}

describe('the mock\'s monitors API, against ruler/openapi.json', () => {
  it('the list, each filter, and one monitor with its history, conform to the ruler\'s schemas', () => {
    const m = mock()
    const all = m.call('GET', '/api/v1/monitors?filter=all')
    expect(all.status).toBe(200)
    expect(all.body.monitors.map((x: { state: string }) => x.state).sort()).toEqual(['error', 'firing', 'firing', 'no_data', 'ok', 'ok', 'pending'])
    expect(all.body.total).toBe(7)
    expect(all.body.counts).toMatchObject({ firing: 2, pending: 1, no_data: 1, error: 1, ok: 2 })
    const attention = m.call('GET', '/api/v1/monitors?filter=attention')
    expect(attention.body.monitors.map((x: { state: string }) => x.state).sort()).toEqual(['error', 'firing', 'firing', 'no_data', 'pending'])
    const silenced = m.call('GET', '/api/v1/monitors?filter=silenced')
    expect(silenced.body.monitors.map((x: { name: string }) => x.name)).toEqual(['Catalog p99 latency'])
    expect(m.call('GET', '/api/v1/monitors').body.monitors).toHaveLength(7)
    for (const mon of all.body.monitors) {
      const one = m.call('GET', `/api/v1/monitors/${mon.id}`)
      expect(one.body.monitor).toEqual(mon)
      // Merged history, oldest first (ruler/src/monitors.ts mergeTimelines).
      const ats = one.body.history.entries.map((e: { at: number }) => e.at)
      expect([...ats].sort((a, b) => a - b)).toEqual(ats)
    }
    m.call('GET', '/api/v1/monitors/silences')
  })

  it('refuses as the ruler does: an unknown filter, an unknown monitor, a route it does not have, a method it does not take', () => {
    const m = mock()
    // 400 is not among the list's documented answers in ruler/openapi.json (the ruler does send it: http.ts listMonitors), so it is checked here without a schema.
    expect(m.api.handle('GET', '/api/v1/monitors?filter=firing', '', { authorization: `Bearer ${ON_CALL}` }).body).toEqual({ error: { code: 'bad_request', message: 'filter must be all, attention or silenced' } })
    const missing = m.call('GET', '/api/v1/monitors/mon_0000000000000000')
    expect([missing.status, missing.body.error]).toEqual([404, { code: 'not_found', message: 'monitor mon_0000000000000000 not found' }])
    const api = createMockApi(OPTS)
    expect(api.handle('GET', '/api/v1/monitors/a/b/c', '', { authorization: `Bearer ${ON_CALL}` }).body).toEqual({ error: { code: 'not_found', message: 'no such route' } })
    expect(api.handle('PATCH', '/api/v1/monitors', '', { authorization: `Bearer ${ON_CALL}` }).status).toBe(405)
  })

  it('the key decides: none is 401 with a challenge, a key without the scope is 403 in the ruler\'s words, before anything is done', () => {
    const m = mock()
    const none = m.call('GET', '/api/v1/monitors', undefined, null)
    expect([none.status, none.body.error.message, none.headers['WWW-Authenticate']]).toEqual([401, 'missing API key', 'Bearer realm="viz"'])
    const readOnly = m.call('GET', '/api/v1/monitors', undefined, READ_ONLY)
    expect([readOnly.status, readOnly.body.error]).toEqual([403, { code: 'forbidden', message: 'API key lacks the monitors:read scope' }])
    const id = m.call('GET', '/api/v1/monitors?filter=attention').body.monitors.find((x: { state: string }) => x.state === 'firing').id
    const ack = m.call('POST', `/api/v1/monitors/${id}/acknowledge`, {}, READER)
    expect([ack.status, ack.body.error.message]).toEqual([403, 'API key lacks the monitors:ack scope'])
    const sil = m.call('POST', `/api/v1/monitors/${id}/silence`, { duration: '1h' }, READER)
    expect(sil.status).toBe(403)
    // Nothing was done by either refusal.
    const after = m.call('GET', `/api/v1/monitors/${id}`, undefined, READER).body.monitor
    expect([after.acknowledged, after.silencedUntil]).toEqual([null, null])
  })

  it('acknowledge: every firing alert, who and when; the first stands; unacknowledge takes it back; both are in the history', () => {
    const m = mock()
    const firing = m.call('GET', '/api/v1/monitors?filter=attention').body.monitors.find((x: { name: string }) => x.name === 'Checkout 5xx ratio')
    const r = m.call('POST', `/api/v1/monitors/${firing.id}/acknowledge`)
    expect(r.body).toMatchObject({ dryRun: false, id: firing.id, acknowledged: [firing.alerts[0].fingerprint], by: 'key:on-call key' })
    const at = r.body.at
    m.advance(5000)
    const second = m.call('POST', `/api/v1/monitors/${firing.id}/acknowledge`, {}, ON_CALL)
    expect(second.body.at).toBe(at + 5000)
    const doc = m.call('GET', `/api/v1/monitors/${firing.id}`).body
    expect(doc.monitor.acknowledged).toEqual({ by: 'key:on-call key', at })
    expect(doc.monitor.state).toBe('firing') // hides nothing
    expect(doc.history.entries.filter((e: { kind: string }) => e.kind === 'acknowledged')).toHaveLength(1)
    m.call('POST', `/api/v1/monitors/${firing.id}/unacknowledge`, {})
    const back = m.call('GET', `/api/v1/monitors/${firing.id}`).body
    expect(back.monitor.acknowledged).toBeNull()
    expect(back.history.entries.at(-1)).toMatchObject({ kind: 'unacknowledged', by: 'key:on-call key', source: 'notifier' })
    // One alert by fingerprint; one that is not firing is 404.
    expect(m.call('POST', `/api/v1/monitors/${firing.id}/acknowledge`, { fingerprint: firing.alerts[0].fingerprint }).status).toBe(200)
    expect(m.call('POST', `/api/v1/monitors/${firing.id}/acknowledge`, { fingerprint: '0000000000000000' }).status).toBe(404)
  })

  it('silence: one silence per firing alert for the duration, an undo token for 60 s that undoes exactly that call, 410 after the window', () => {
    const m = mock()
    const firing = m.call('GET', '/api/v1/monitors?filter=attention').body.monitors.find((x: { name: string }) => x.name === 'Checkout 5xx ratio')
    expect(m.call('POST', `/api/v1/monitors/${firing.id}/silence`, {}).status).toBe(422)
    expect(m.call('POST', `/api/v1/monitors/${firing.id}/silence`, { duration: '31d' }).body.problems[0].path).toBe('duration')
    const r = m.call('POST', `/api/v1/monitors/${firing.id}/silence`, { duration: '1h' })
    const now = Date.UTC(2026, 10, 28, 9, 30)
    expect(r.body).toMatchObject({ dryRun: false, id: firing.id, silenced: [firing.alerts[0].fingerprint], undoUntil: now + 60_000 })
    expect(r.body.silences[0]).toMatchObject({ endsAt: now + 3_600_000, state: 'active', createdBy: 'key:on-call key' })
    expect(r.body.silences[0].matchers.map((x: { name: string }) => x.name)).toEqual(Object.keys(firing.alerts[0].labels).sort())
    expect(m.call('GET', `/api/v1/monitors/${firing.id}`).body.monitor.silencedUntil).toBe(now + 3_600_000)
    expect(m.call('POST', '/api/v1/monitors/silences/undo', { undoToken: 'nope' }).status).toBe(404)
    expect(m.call('POST', '/api/v1/monitors/silences/undo', {}).status).toBe(422)
    // Inside the window: removed, as if never made.
    m.advance(59_000)
    const undone = m.call('POST', '/api/v1/monitors/silences/undo', { undoToken: r.body.undoToken })
    expect(undone.body.removed).toEqual([r.body.silences[0].id])
    expect(m.call('GET', `/api/v1/monitors/${firing.id}`).body.monitor.silencedUntil).toBeNull()
    // A second silence, and its window allowed to close.
    const again = m.call('POST', `/api/v1/monitors/${firing.id}/silence`, { duration: '15m' })
    m.advance(60_001)
    const late = m.call('POST', '/api/v1/monitors/silences/undo', { undoToken: again.body.undoToken })
    expect(late.status).toBe(410)
    expect(late.body.error.code).toBe('undo_expired')
    expect(late.body.error.message).toMatch(/^the undo window closed at 2026-11-28T09:\d\d:\d\d\.\d{3}Z; expire the silence instead$/)
    expect(m.call('GET', `/api/v1/monitors/${firing.id}`).body.monitor.silencedUntil).not.toBeNull()
    const kinds = m.call('GET', `/api/v1/monitors/${firing.id}`).body.history.entries.map((e: { kind: string }) => e.kind)
    expect(kinds.slice(-3)).toEqual(['silenced', 'silence_undone', 'silenced'])
  })

  it('dryRun changes nothing (the app never sends it; the mock answers it as the ruler does)', () => {
    const m = mock()
    const firing = m.call('GET', '/api/v1/monitors?filter=attention').body.monitors.find((x: { name: string }) => x.name === 'Checkout 5xx ratio')
    expect(m.call('POST', `/api/v1/monitors/${firing.id}/acknowledge?dryRun=true`, {}, ON_CALL, '/api/v1/monitors/{id}/acknowledge').body.dryRun).toBe(true)
    const s = m.call('POST', `/api/v1/monitors/${firing.id}/silence`, { duration: '1h', dryRun: true })
    expect([s.body.dryRun, s.body.undoToken]).toEqual([true, null])
    const after = m.call('GET', `/api/v1/monitors/${firing.id}`).body.monitor
    expect([after.acknowledged, after.silencedUntil]).toEqual([null, null])
  })

  it('a pending monitor has nothing to act on: acknowledging it applies to no alert', () => {
    const m = mock()
    const pending = m.call('GET', '/api/v1/monitors?filter=attention').body.monitors.find((x: { state: string }) => x.state === 'pending')
    expect(m.call('POST', `/api/v1/monitors/${pending.id}/acknowledge`).body.acknowledged).toEqual([])
    const s = m.call('POST', `/api/v1/monitors/${pending.id}/silence`, { duration: '1h' })
    expect([s.body.undoToken, s.body.undoUntil, s.body.silences]).toEqual([null, null, []])
  })

  it('the validator has teeth: a monitor without its state, or with a state the ruler does not have, is refused', () => {
    const m = mock()
    const mon = m.call('GET', '/api/v1/monitors').body.monitors[0]
    const schema = { $ref: '#/components/schemas/Monitor' }
    expect(validateSchema(schema, mon)).toEqual([])
    const { state: _s, ...noState } = mon
    expect(validateSchema(schema, noState)).toEqual(['$: state is required'])
    expect(validateSchema(schema, { ...mon, state: 'broken' })).toHaveLength(1)
    expect(validateSchema(schema, { ...mon, firingSince: 'soon' })).toHaveLength(1)
  })
})
