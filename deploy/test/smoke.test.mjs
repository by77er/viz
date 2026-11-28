// node --test deploy/test/: smoke.mjs's D75 host checks, against a stub fetch (nothing is reached).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkHosts, checkHostsOnce } from '../smoke.mjs'

const VIZ = 'https://viz.bitcru.sh'
const META = '/.well-known/oauth-authorization-server'

/** A production as D75 wants it, with `over` replacing the answer for `METHOD url`. */
const site = (over = {}) => async (url, init = {}) => {
  const key = `${init.method ?? 'GET'} ${url}`
  assert.equal(init.redirect, 'manual', `${key} must not follow redirects`)
  if (over[key]) return over[key]()
  if (key === `GET ${VIZ}${META}`) return Response.json({ issuer: VIZ })
  if (key === 'POST https://vis.bitcru.sh/api/v1/write') return new Response('unauthorized', { status: 401, headers: { 'x-viz-route': 'ingest', Deprecation: '@1795824000', Link: `<${VIZ}/api/v1/write>; rel="successor-version"` } })
  if (key === `GET https://vis.bitcru.sh${META}`) return new Response(null, { status: 308, headers: { Location: `${VIZ}${META}` } })
  throw new Error(`unexpected ${key}`)
}

test('passes on production as D75 wants it', async () => {
  assert.deepEqual(await checkHostsOnce(VIZ, ['vis.bitcru.sh'], site()), { ok: true, problems: [] })
})

test('fails when vis redirects the data path, serves OAuth itself, or the issuer is not viz', async () => {
  const cases = {
    'POST https://vis.bitcru.sh/api/v1/write': [() => new Response(null, { status: 308, headers: { Location: `${VIZ}/api/v1/write` } }), /was redirected \(308/],
    [`GET https://vis.bitcru.sh${META}`]: [() => Response.json({ issuer: 'https://vis.bitcru.sh' }), /answered 200, not 308/],
    [`GET ${VIZ}${META}`]: [() => Response.json({ issuer: 'https://vis.bitcru.sh' }), /issuer "https:\/\/vis\.bitcru\.sh", not https:\/\/viz\.bitcru\.sh/],
  }
  for (const [key, [answer, pattern]] of Object.entries(cases)) {
    const r = await checkHostsOnce(VIZ, ['vis.bitcru.sh'], site({ [key]: answer }))
    assert.equal(r.ok, false, key)
    assert.match(r.problems.join('\n'), pattern, key)
  }
  const noHeaders = await checkHostsOnce(VIZ, ['vis.bitcru.sh'], site({ 'POST https://vis.bitcru.sh/api/v1/write': () => new Response('x', { status: 401, headers: { 'x-viz-route': 'ingest' } }) }))
  assert.match(noHeaders.problems.join('\n'), /lacks Deprecation/)
  const wrongTarget = await checkHostsOnce(VIZ, ['vis.bitcru.sh'], site({ [`GET https://vis.bitcru.sh${META}`]: () => new Response(null, { status: 301, headers: { Location: `${VIZ}/` } }) }))
  assert.match(wrongTarget.problems.join('\n'), /answered 301 to https:\/\/viz\.bitcru\.sh\/, not 308/)
  // The right place, but 301 or 302 (a client may turn POST into GET) or 307 (temporary): not D75's 308.
  for (const status of [301, 302, 307]) {
    const r = await checkHostsOnce(VIZ, ['vis.bitcru.sh'], site({ [`GET https://vis.bitcru.sh${META}`]: () => new Response(null, { status, headers: { Location: `${VIZ}${META}` } }) }))
    assert.match(r.problems.join('\n'), new RegExp(`answered ${status} to .*, not 308`), String(status))
  }
  const down = await checkHostsOnce(VIZ, ['vis.bitcru.sh'], async () => { throw new Error('ENOTFOUND') })
  assert.equal(down.problems.length, 3)
})

test('checkHosts retries until it passes, and gives up at its deadline', async () => {
  let n = 0
  const flaky = async (url, init) => (++n <= 3 ? new Response('old version', { status: 200 }) : site()(url, init))
  const r = await checkHosts(VIZ, ['vis.bitcru.sh'], 10_000, flaky, 1)
  assert.equal(r.ok, true)
  assert.ok(r.attempts >= 2)
  const never = await checkHosts(VIZ, ['vis.bitcru.sh'], 20, async () => new Response('no', { status: 404 }), 5)
  assert.equal(never.ok, false)
})
