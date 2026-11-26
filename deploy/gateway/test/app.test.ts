/**
 * The web app behind the gateway (design/DECISIONS.md D74). The specification is app/serve.json,
 * read here, now: a later change to it changes what these tests demand, or fails them (a rule this
 * file does not know), rather than drifting from what the gateway serves.
 *
 * What runs here is the Worker's part: the documents, and what the Worker answers for every path
 * that is not a file of the build (an unknown path, a hashed asset this version does not hold).
 * The test Worker's VIZ_APP is made by deploy/lib/app.mjs from serve.json and the fixture build in
 * test/fixtures/app-build (vitest.config.ts), as deploy/configure.mjs makes it. Cloudflare's part,
 * the files themselves with their headers, is tested against a real workerd asset server in
 * test/app-serve.test.mjs.
 */
import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import SERVE from '../../../app/serve.json'
import DOCUMENT from '../../test/fixtures/app-build/index.html?raw'
import { type Env, handle, parseApp, routeOf } from '../src/index'

const BASE = 'https://vis.bitcru.sh'
const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`${BASE}${path}`, init))
const withApp = (app: unknown, path: string, init?: RequestInit) => handle(new Request(`${BASE}${path}`, init), { ...(env as unknown as Env), VIZ_APP: typeof app === 'string' ? app : JSON.stringify(app) })

const DOCUMENTS: string[] = SERVE.documents
const DOCUMENT_HEADERS: Record<string, string> = SERVE.headers.document
const real = () => JSON.parse(env.VIZ_APP!) as { v: number; build: string; etag: string; documents: string[]; headers: Record<string, string>; document: string }

/** The gateway's 404, exactly: JSON, never stored, never a page. */
async function expectJson404(res: Response, what: string) {
  expect(res.status, what).toBe(404)
  expect(res.headers.get('content-type'), what).toBe('application/json; charset=utf-8')
  expect(res.headers.get('cache-control'), what).toBe('no-store')
  expect(res.headers.get('content-security-policy'), what).toBeNull()
  expect(res.headers.get('x-viz-route'), what).toBe('gateway')
  const text = await res.text()
  expect(text, what).not.toContain('<!doctype')
  expect(JSON.parse(text), what).toMatchObject({ status: 'error', errorType: 'not_found' })
}

describe('app/serve.json is the specification', () => {
  it('holds only rules the gateway serves by (a new rule fails here instead of being ignored)', () => {
    expect(Object.keys(SERVE).sort()).toEqual(['assetsPrefix', 'comment', 'contentTypes', 'documents', 'files', 'headers'])
    expect(Object.keys(SERVE.headers).sort()).toEqual(['asset', 'document', 'file'])
  })

  it('names no path of the API: no document, file or asset prefix is something routeOf routes', () => {
    for (const p of [...DOCUMENTS, ...SERVE.files, SERVE.assetsPrefix, `${SERVE.assetsPrefix}index-00000000.js`]) expect(routeOf(p), p).toBeNull()
    for (const p of [...DOCUMENTS, ...SERVE.files]) expect(p.startsWith('/api/') || p === '/api', p).toBe(false)
  })

  it('the test Worker was configured from it: VIZ_APP holds its documents and document headers, and the fixture document', () => {
    const app = real()
    expect(app.documents).toEqual(DOCUMENTS)
    expect(app.headers).toEqual(DOCUMENT_HEADERS)
    expect(app.document).toBe(DOCUMENT)
  })
})

describe('documents', () => {
  it.each(DOCUMENTS)('GET %s is the document, with every header serve.json gives a document, exactly', async (path) => {
    const res = await call(path)
    expect(res.status).toBe(200)
    for (const [name, value] of Object.entries(DOCUMENT_HEADERS)) expect(res.headers.get(name), name).toBe(value)
    expect(res.headers.get('content-security-policy')).toBe(DOCUMENT_HEADERS['Content-Security-Policy'])
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(res.headers.get('x-viz-route')).toBe('app')
    expect(await res.text()).toBe(DOCUMENT)
  })

  it('a document is never given what an asset or a file gets: nothing lets a cache keep it', async () => {
    for (const path of DOCUMENTS) {
      const cc = (await call(path)).headers.get('cache-control') ?? ''
      expect(cc, path).not.toMatch(/immutable|max-age=[1-9]|public/)
      expect(cc, path).not.toBe(SERVE.headers.asset['Cache-Control'])
      expect(cc, path).not.toBe(SERVE.headers.file['Cache-Control'])
    }
  })

  it('HEAD of a document: 200, the same headers, no body', async () => {
    const res = await call(DOCUMENTS[1] ?? '/', { method: 'HEAD' })
    expect(res.status).toBe(200)
    for (const [name, value] of Object.entries(DOCUMENT_HEADERS)) expect(res.headers.get(name), name).toBe(value)
    expect(await res.text()).toBe('')
  })

  it('the query string is the page\'s own: /explore?q=… is the document', async () => {
    const res = await call(`${DOCUMENTS.find((d) => d !== '/') ?? '/'}?q=${encodeURIComponent('sum(rate(http_requests_total[5m]))')}&from=1&to=2`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(DOCUMENT)
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('%s to a document path is the JSON 404: only GET and HEAD are the app\'s', async (method) => {
    for (const path of DOCUMENTS) await expectJson404(await call(path, { method, ...(method === 'OPTIONS' || method === 'DELETE' ? {} : { body: 'key=viz_x' }) }), `${method} ${path}`)
  })

  it('revalidation: the document carries an entity tag; naming it gets 304 with the same headers and no body; another tag gets the document', async () => {
    const first = await call('/')
    const etag = first.headers.get('etag')!
    expect(etag).toBe(real().etag)
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/)
    for (const tag of [etag, `W/${etag}`, `"other", ${etag}`]) {
      const res = await call('/', { headers: { 'If-None-Match': tag } })
      expect(res.status, tag).toBe(304)
      expect(await res.text()).toBe('')
      for (const [name, value] of Object.entries(DOCUMENT_HEADERS)) if (name.toLowerCase() !== 'content-type') expect(res.headers.get(name), name).toBe(value)
      expect(res.headers.get('etag')).toBe(etag)
    }
    const other = await call('/', { headers: { 'If-None-Match': '"0000000000000000000000000000dead"' } })
    expect(other.status).toBe(200)
    expect(await other.text()).toBe(DOCUMENT)
  })
})

describe('everything else is the JSON 404, never the document', () => {
  // What reaches the Worker: every path that is not a file of this version's build. Cloudflare
  // serves the files that exist without invoking it (test/app-serve.test.mjs).
  const notDocuments = [
    '/explore/', '/explorer', '/Explore', '/EXPLORE', '/explore.html', '/index.html', '/index', '/explore/x', '/explore%2F', '/explore%20', '//explore', '/explore//', '/help/', '/settings/keys',
    '/dashboards', '/logs', '/traces', '/.env', '/.git/config', '/src/main.tsx', '/package.json', '/serve.json', '/_headers', '/robots.txt', '/favicon.ico', '/assets', '/static/x.js',
  ]
  it.each(notDocuments)('GET %s', async (path) => {
    await expectJson404(await call(path), path)
  })

  it('a hashed asset this version does not hold (a page of another build asking for its chunk) is the JSON 404, not stored, never the document', async () => {
    for (const path of [`${SERVE.assetsPrefix}index-00000000.js`, `${SERVE.assetsPrefix}PromqlEditor-D1eCvk3-.js`, `${SERVE.assetsPrefix}index-n3zlISeH.css`, `${SERVE.assetsPrefix}`, `${SERVE.assetsPrefix}x/y.js`, ...SERVE.files]) {
      for (const method of ['GET', 'HEAD', 'POST']) {
        const res = await call(path, { method })
        if (method === 'HEAD') {
          expect(res.status, path).toBe(404)
          expect(res.headers.get('cache-control'), path).toBe('no-store')
        } else await expectJson404(res, `${method} ${path}`)
        expect(res.headers.get('cache-control'), path).not.toMatch(/immutable|max-age/)
      }
    }
  })

  it('a path that only decodes or normalises to something else is judged as it arrives', async () => {
    // The URL parser removes dot segments (also percent-encoded ones) before the Worker sees the path:
    // these arrive as /index.html, /favicon.svg, /explore. Only the last is a document.
    await expectJson404(await call(`${SERVE.assetsPrefix}../index.html`), 'dot segments to index.html')
    await expectJson404(await call(`${SERVE.assetsPrefix}%2e%2e/index.html`), 'encoded dot segments to index.html')
    expect((await call('/x/../explore')).status).toBe(DOCUMENTS.includes('/explore') ? 200 : 404)
    // An encoded slash or backslash is not a separator: the path is not a document.
    for (const p of [`${SERVE.assetsPrefix}..%2findex.html`, `${SERVE.assetsPrefix}..%2f..%2fexplore`, '/%2e%2e%2fexplore', '/explore%2f', '/%65xplore', '/explore%00', '/explore;x=1', '/explore%3Fq=1']) await expectJson404(await call(p), p)
  })
})

describe('the API comes first and is never answered with a page', () => {
  const browser = { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }

  it.each(['/api', '/api/', '/api/v1', '/api/v1/', '/api/v1/nope', '/api/v1/querys', '/api/v2/query', '/api/v1/bootstrapx', '/oauth', '/oauth/x', '/mcp/', '/mcp/x', '/v1', '/v1/x', '/loki/api/v1/tail', '/.well-known/x', '/healthz/', '/healthzz'])(
    'an unknown API path, opened in a browser: %s is the JSON 404',
    async (path) => {
      await expectJson404(await call(path, { headers: browser }), path)
    },
  )

  it('a known API path still reaches its backend, also when a browser navigates to it', async () => {
    for (const [path, backend] of [['/api/v1/query?query=up', 'query'], ['/api/v1/labels', 'query'], ['/api/v1/control/keys', 'control'], ['/api/v1/rules', 'ruler'], ['/oauth/authorize', 'control'], ['/mcp', 'mcp']] as const) {
      const res = await call(path, { headers: browser })
      expect(res.headers.get('x-viz-route'), path).toBe(backend)
      expect(res.headers.get('content-security-policy'), path).toBeNull()
      expect(await res.text(), path).not.toContain('<!doctype')
    }
    const health = await call('/healthz')
    expect(health.headers.get('x-viz-route')).toBe('health')
    expect(health.headers.get('content-type')).toBe('application/json; charset=utf-8')
  })

  it('a VIZ_APP that names an API path as a document is no app at all: the path reaches its backend, and no page is served', async () => {
    const evil = { ...real(), documents: ['/', '/api/v1/query', '/healthz'] }
    expect(parseApp(JSON.stringify(evil))).toBeNull()
    const res = await withApp(evil, '/api/v1/query?query=up')
    expect(res.headers.get('x-viz-route')).toBe('query')
    expect(await res.text()).not.toContain('<!doctype')
    await expectJson404(await withApp(evil, '/'), '/')
    expect((await withApp(evil, '/healthz')).headers.get('x-viz-route')).toBe('health')
  })
})

describe('no app, or not an app', () => {
  it('without VIZ_APP every app path is the 404 it always was', async () => {
    for (const path of [...DOCUMENTS, ...SERVE.files, `${SERVE.assetsPrefix}index-00000000.js`]) {
      await expectJson404(await handle(new Request(`${BASE}${path}`), { ...(env as unknown as Env), VIZ_APP: undefined }), path)
    }
  })

  it('a document is served only with its policy, its type and revalidation: a VIZ_APP without them serves no page', async () => {
    const app = real()
    const without = (name: string) => ({ ...app, headers: Object.fromEntries(Object.entries(app.headers).filter(([k]) => k !== name)) })
    const bad: [string, unknown][] = [
      ['no Content-Security-Policy', without('Content-Security-Policy')],
      ['no Content-Type', without('Content-Type')],
      ['no Cache-Control', without('Cache-Control')],
      ['kept for good', { ...app, headers: { ...app.headers, 'Cache-Control': SERVE.headers.asset['Cache-Control'] } }],
      ['not HTML', { ...app, headers: { ...app.headers, 'Content-Type': 'text/plain' } }],
      ['a header over two lines', { ...app, headers: { ...app.headers, 'X-Frame-Options': 'DENY\r\nSet-Cookie: a=1' } }],
      ['no document', { ...app, document: '' }],
      ['no documents', { ...app, documents: [] }],
      ['another version of the shape', { ...app, v: 2 }],
      ['no entity tag', { ...app, etag: undefined }],
      ['not JSON', '<!doctype html><title>viz</title>'],
      ['JSON, not an object', '[]'],
    ]
    for (const [what, value] of bad) {
      expect(parseApp(typeof value === 'string' ? value : JSON.stringify(value)), what).toBeNull()
      await expectJson404(await withApp(value, '/'), what)
    }
    expect(parseApp(JSON.stringify(app))).not.toBeNull()
  })
})
