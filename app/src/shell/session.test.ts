import { describe, expect, it, vi } from 'vitest'
import { PromApiError, PromClient } from '../api/client'
import { createMockApi } from '../../mock/handler'
import { keyPrefix, sessionAfter, signInResult, type WhoamiOutcome } from './session'

const identity = (scopes: string[]) => ({ identity: { tenant: 'acme', subject: 'key:1', kind: 'key', name: 'on-call', scopes } })
const answered = (status: number, message = `HTTP ${status}`): WhoamiOutcome => ({ status, message })

describe('who gets in (session)', () => {
  it('a key the API knows is signed in, with its identity', () => {
    expect(sessionAfter(true, identity(['read']))).toEqual({ status: 'in', identity: identity(['read']).identity })
  })
  it('an API that needs no key (the development mock) lets a tab without one in', () => {
    expect(sessionAfter(false, identity(['read'])).status).toBe('in')
  })
  it('a 401 is the sign-in form: "no key" without one, "refused" with one', () => {
    expect(sessionAfter(false, answered(401))).toEqual({ status: 'out', reason: 'none' })
    expect(sessionAfter(true, answered(401))).toEqual({ status: 'out', reason: 'refused' })
    expect(sessionAfter(true, answered(403))).toEqual({ status: 'out', reason: 'refused' })
  })
  it('an API with no control plane (404) has nothing to sign in to', () => {
    expect(sessionAfter(false, answered(404))).toEqual({ status: 'in', identity: null, unchecked: 'no-control' })
    expect(sessionAfter(true, answered(404))).toEqual({ status: 'in', identity: null, unchecked: 'no-control' })
  })
  it('when the API does not answer, a tab with a key carries on and a tab without one is asked for one', () => {
    for (const status of [0, 429, 500, 502, 503]) {
      expect(sessionAfter(true, answered(status))).toEqual({ status: 'in', identity: null, unchecked: 'no-answer' })
      expect(sessionAfter(false, answered(status, 'no answer'))).toEqual({ status: 'out', reason: 'no-answer', detail: 'no answer' })
    }
  })
})

describe('what a typed key comes to (sign-in)', () => {
  it('a key that can read is accepted', () => {
    expect(signInResult(identity(['read']))).toEqual({ ok: true })
    expect(signInResult(identity(['write', 'read', 'admin']))).toEqual({ ok: true })
  })
  it('a valid key without the read scope is refused at the field, with its scopes, and never stored', () => {
    const r = signInResult(identity(['write']))
    expect(r).toMatchObject({ ok: false, where: 'field' })
    expect(r.ok === false && r.message).toContain('the write scope')
    expect(r.ok === false && r.message).toContain('acme')
    // admin is not read: the query API checks the read scope literally (edge/src/auth.ts).
    expect(signInResult(identity(['admin']))).toMatchObject({ ok: false, where: 'field' })
    expect(signInResult(identity([]))).toMatchObject({ ok: false, where: 'field' })
  })
  it('a key the API refuses is a problem with the key; an API that does not answer is not', () => {
    expect(signInResult(answered(401))).toMatchObject({ ok: false, where: 'field' })
    expect(signInResult(answered(403))).toMatchObject({ ok: false, where: 'field' })
    for (const status of [0, 404, 429, 500, 503]) expect(signInResult(answered(status, 'Cannot reach the API'))).toMatchObject({ ok: false, where: 'notice' })
    const none = signInResult(answered(0, 'Cannot reach the API: Failed to fetch'))
    expect(none.ok === false && none.message).toContain('Nothing was stored')
  })
  it('no message ever repeats the key', () => {
    for (const o of [identity(['write']), answered(401), answered(0, 'x'), answered(503)]) {
      const r = signInResult(o)
      expect(JSON.stringify(r)).not.toContain('s3cret')
    }
  })
  it('shows a key by its public part only', () => {
    expect(keyPrefix('viz_AbCdEf0123456789_0123456789abcdefghijABCDEFGHIJ0123456789')).toBe('viz_AbCdEf0123456789_…')
    expect(keyPrefix('viz_AbCdEf0123456789_0123456789abcdefghijABCDEFGHIJ0123456789')).not.toContain('0123456789abcdefghij')
    expect(keyPrefix('not-a-viz-key')).toBe('')
    expect(keyPrefix('')).toBe('')
  })
})

describe('whoami through the client, against the mock (control\'s route)', () => {
  const viaMock = (opts: Parameters<typeof createMockApi>[0], token?: string) => {
    const api = createMockApi(opts)
    const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers)
      const out = api.handle(init?.method ?? 'GET', String(input), '', { authorization: h.get('Authorization') ?? undefined })
      return new Response(JSON.stringify(out.body), { status: out.status, headers: out.headers })
    })
    return { client: new PromClient({ token, fetch: f as unknown as typeof fetch }), f }
  }
  it('asks /api/v1/control/whoami with the key in the Authorization header and nowhere else', async () => {
    const { client, f } = viaMock({ requireToken: 's3cret' }, 's3cret')
    expect(await client.whoami()).toEqual({ tenant: 'viz-mock', subject: 'key:read key', kind: 'key', name: 'read key', scopes: ['read'], mock: true })
    const [url, init] = f.mock.calls[0]!
    expect(url).toBe('/api/v1/control/whoami')
    expect(init!.method).toBe('GET')
    expect(init!.body).toBeUndefined()
    expect(new Headers(init!.headers).get('Authorization')).toBe('Bearer s3cret')
  })
  it('an unknown key, and no key, are 401', async () => {
    for (const token of ['nope', undefined]) {
      const e = await viaMock({ requireToken: 's3cret' }, token)
        .client.whoami()
        .catch((x) => x)
      expect(e).toBeInstanceOf(PromApiError)
      expect(e.status).toBe(401)
    }
  })
  it('a key without the read scope is still told who it is', async () => {
    expect((await viaMock({ requireToken: 's3cret', readlessToken: 'w' }, 'w').client.whoami()).scopes).toEqual(['write'])
  })
  it('the mock without a required key answers for a key of its own', async () => {
    expect((await viaMock({}).client.whoami()).scopes).toEqual(['read', 'dashboards:read', 'monitors:read', 'monitors:ack'])
  })
  it('an answer that is not an identity is refused, not trusted', async () => {
    const f = vi.fn(async () => new Response('<html>hello</html>', { status: 200 }))
    const e = await new PromClient({ fetch: f as unknown as typeof fetch }).whoami().catch((x) => x)
    expect(e).toMatchObject({ errorType: 'parse', status: 200 })
    const g = vi.fn(async () => new Response(JSON.stringify({ status: 'success', data: {} }), { status: 200 }))
    expect(await new PromClient({ fetch: g as unknown as typeof fetch }).whoami().catch((x) => x)).toMatchObject({ errorType: 'parse' })
  })
})
