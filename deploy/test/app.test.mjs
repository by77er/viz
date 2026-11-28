// node --test deploy/test/: the web app's build, from its sources to a release (design/DECISIONS.md D74;
// deploy/lib/app.mjs, deploy/app.mjs, and their use in configure.mjs and release.mjs).
//
// - app/serve.json, read here, is what the gateway is configured from; a rule this code does not
//   know is refused;
// - a build is read by those rules, staged without index.html, and described by a stamp;
// - a missing, stale or altered build is refused by configure.mjs and, whatever configure did, by
//   release.mjs before anything is uploaded (against the fake account, test/fake-account.mjs);
// - files of earlier builds are kept for pages opened before a deploy, only with the recorded bytes;
// - a rollback says which build, or none, the restored viz-gateway serves.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { after, beforeEach, test } from 'node:test'

// Before the deploy modules load: generated/ is this test's own.
const tmp = mkdtempSync(join(tmpdir(), 'viz-app-test-'))
process.env.VIZ_GENERATED_DIR = join(tmp, 'generated')
const A = await import('../lib/app.mjs')
const { DEPLOY_DIR, GENERATED_DIR, REPO_ROOT, readJson, readJsonc } = await import('../lib/common.mjs')
const { APP_FIXTURE, WITHOUT_APP, appBuilt, callsLike, captured, cmd, installFakeAccount, serving } = await import('./fake-account.mjs')
const { build, handover, servingAppFiles } = await import('../app.mjs')
const { configure, generateWorker } = await import('../configure.mjs')
const { APP_STAGE_BY_HAND, appProblems, appStageProblems, deploy, evidenceGaps, planOnly, rollback } = await import('../release.mjs')
const { evidenceEntry } = await import('../scripts/app-stage-evidence.mjs')

/** The value a test puts where a credential would be. Never a real one: these tests run with the real ones removed. */
const DUMMY = 'DUMMY-not-a-credential-123'
/** For tests that are not about it: the owner's override of the stage-before-production rule (review of D74, M-2). */
const NO_STAGE = 'a test that is about something else'

const account = installFakeAccount(tmp)
const { writeState, readState } = account
after(() => {
  account.restore()
  rmSync(tmp, { recursive: true, force: true })
})
beforeEach(() => {
  rmSync(GENERATED_DIR, { recursive: true, force: true })
  writeState({ calls: [], counter: 100, workers: {} })
})

const PLAN = readJson(join(DEPLOY_DIR, 'workers.json'))
const SERVE_FILE = join(REPO_ROOT, 'app', 'serve.json')
const SERVE = A.readServe(SERVE_FILE)
const RAW = JSON.parse(readFileSync(SERVE_FILE, 'utf8'))
let n = 0
const scratch = (name) => {
  const d = join(tmp, `${name}-${++n}`)
  mkdirSync(d, { recursive: true })
  return d
}
/** A copy of the fixture build that a test may change. */
const fixtureCopy = () => {
  const d = scratch('build')
  cpSync(APP_FIXTURE, d, { recursive: true })
  return d
}
const serveWith = (change) => {
  const f = join(scratch('serve'), 'serve.json')
  const v = structuredClone(RAW)
  change(v)
  writeFileSync(f, JSON.stringify(v))
  return f
}

// ───────────────────────── app/serve.json ─────────────────────────

test('app/serve.json is read as the specification; workers.json names it, and the app as built from app/ and design-system/', () => {
  const found = A.appWorker(PLAN)
  assert.equal(found.worker.name, 'viz-gateway')
  // dashboard/src: the app's dashboards views import the viz.dashboard/v1 model from it by relative path.
  assert.deepEqual([found.app.dir, found.app.serve, found.app.needs], ['app', 'app/serve.json', ['design-system', 'dashboard/src']])
  // Everything the app imports from outside app/ lies in a directory the build exports: an import
  // of another one builds in the checkout and fails in the export (it did, for dashboard/, on 2026-11-27).
  const outside = new Set()
  const scan = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue
      const p = join(dir, e.name)
      if (e.isDirectory()) scan(p)
      else if (/\.(ts|tsx|css)$/.test(e.name)) for (const m of readFileSync(p, 'utf8').matchAll(/(?:from|import|url\()\s*\(?['"]((?:\.\.\/)+[^'"]+)['"]/g)) {
        const target = relative(REPO_ROOT, join(dir, m[1])).split(sep).join('/')
        if (!target.startsWith('app/') && !target.startsWith('..')) outside.add(target)
      }
    }
  }
  scan(join(REPO_ROOT, 'app', 'src'))
  for (const target of outside) assert.ok(found.app.needs.some((d) => target.startsWith(`${d}/`)), `app/src imports ${target}, which is in none of ${found.app.needs.join(', ')} (deploy/workers.json app.needs): the release's build would not have it`)
  assert.ok([...outside].some((t) => t.startsWith('dashboard/src/')) && [...outside].some((t) => t.startsWith('design-system/')), [...outside].join(' '))
  assert.deepEqual(SERVE.documents, RAW.documents)
  assert.equal(SERVE.assetsPrefix, RAW.assetsPrefix)
  assert.deepEqual(SERVE.headers, RAW.headers)
  assert.deepEqual(SERVE.contentTypes, RAW.contentTypes)
  assert.ok(SERVE.documents.includes('/'))
  assert.match(SERVE.headers.document['Content-Security-Policy'], /default-src 'none'/)
})

test('serve.json: a rule this code does not serve by is refused, not ignored', () => {
  const refused = [
    [(v) => (v.redirects = { '/old': '/explore' }), /"redirects" is a rule deploy\/lib\/app\.mjs does not know/],
    [(v) => (v.headers.font = { 'Cache-Control': 'x' }), /headers\.font: only document, asset, file/],
    [(v) => v.documents.push('/explore/'), /not a plain path/],
    [(v) => v.documents.push('/a/../b'), /not a plain path/],
    [(v) => v.documents.push('/a%2Fb'), /not a plain path/],
    [(v) => v.documents.push('/.well-known/x'), /not a plain path/],
    [(v) => v.documents.push('/explore'), /distinct/],
    [(v) => (v.documents = []), /non-empty/],
    [(v) => v.documents.push('/assets/page'), /under the asset prefix/],
    [(v) => (v.assetsPrefix = '/'), /"assetsPrefix" must be one directory/],
    [(v) => (v.assetsPrefix = '/assets'), /"assetsPrefix" must be one directory/],
    [(v) => (v.assetsPrefix = '/a/b/'), /"assetsPrefix" must be one directory/],
    [(v) => v.files.push('/robots.txt'), /robots\.txt has no content type/],
    [(v) => v.files.push('/'), /not a plain path|both a document and a file/],
    [(v) => (v.contentTypes['.html'] = 'text/html\r\nX: y'), /not a content type/],
    [(v) => (v.headers.document['X-Frame-Options'] = 'DENY\nSet-Cookie: a=1'), /one line of printable ASCII/],
    [(v) => (v.headers.document['Bad Header'] = 'x'), /not a header name/],
    [(v) => delete v.headers.document['Content-Security-Policy'], /must carry a Content-Security-Policy/],
    [(v) => (v.headers.document['Cache-Control'] = v.headers.asset['Cache-Control']), /revalidated on every load/],
    [(v) => (v.headers.document['Cache-Control'] = 'no-cache, max-age=600'), /revalidated on every load/],
    [(v) => delete v.headers.document['Cache-Control'], /revalidated on every load/],
    [(v) => (v.headers.document['Content-Type'] = 'text/plain'), /text\/html; charset=utf-8/],
    [(v) => delete v.headers.asset['Cache-Control'], /headers\.asset must carry a Cache-Control/],
    [(v) => (v.headers.asset['Content-Type'] = 'text/javascript'), /comes from "contentTypes"/],
    [(v) => delete v.headers.file, /headers\.file must be an object/],
  ]
  for (const [change, why] of refused) assert.throws(() => A.readServe(serveWith(change)), why)
  assert.throws(() => A.readServe(join(tmp, 'nowhere', 'serve.json')), /not found/)
  A.readServe(serveWith(() => {})) // unchanged, it is accepted
})

test('serve.json: nothing of the app lies in the API\'s part of the path space (the gateway\'s own api-roots.json): no asset prefix, file or document (m-4)', () => {
  // The list is the gateway's file, not a second one; gateway/test/app.test.ts holds routeOf and parseApp to the same file.
  assert.deepEqual(A.API_ROOTS, JSON.parse(readFileSync(join(DEPLOY_DIR, 'gateway', 'src', 'api-roots.json'), 'utf8')))
  assert.deepEqual([A.API_ROOTS.prefixes, A.API_ROOTS.exact], [['/api/', '/v1/', '/loki/', '/oauth/', '/.well-known/'], ['/mcp', '/healthz']])
  const svg = (v, p) => v.files.push(p)
  const refused = [
    // The asset layer answers a file before the Worker runs: a prefix there puts a year of caching on the API's paths.
    ...['/api/', '/v1/', '/oauth/', '/loki/'].map((p) => [(v) => (v.assetsPrefix = p), /"assetsPrefix" \S+ is in the API's part of the path space/]),
    ...['/api/v1/control/openapi.svg', '/api/v1/label/x.svg', '/v1/metrics.svg', '/loki/x.svg', '/oauth/x.svg', '/mcp/x.svg', '/healthz/x.svg', '/api/x.svg'].map((p) => [(v) => svg(v, p), /files: \S+ is in the API's part of the path space .*answered before the API/]),
    ...['/mcp', '/api/echo', '/oauth/authorize', '/healthz', '/api', '/v1', '/api/v1/query', '/api/not-a-route-today', '/loki'].map((p) => [(v) => v.documents.push(p), /documents: \S+ is in the API's part of the path space .*the API comes first/]),
  ]
  for (const [change, why] of refused) assert.throws(() => A.readServe(serveWith(change)), why)
  for (const p of ['/api', '/api/', '/api/x', '/v1', '/v1/traces', '/loki/api/v1/push', '/oauth/token', '/.well-known/x', '/mcp', '/mcp/x', '/healthz', '/healthz/x']) assert.equal(A.underApiRoot(p), true, p)
  // Outside the roots: the app's own paths, and a name that merely starts like a root (it is in front of nothing).
  for (const p of ['/', '/explore', '/assets/', '/assets/x.js', '/favicon.svg', '/mcp.svg', '/apix', '/v10/x', '/healthzz']) assert.equal(A.underApiRoot(p), false, p)
  for (const p of [...SERVE.documents, ...SERVE.files, SERVE.assetsPrefix]) assert.equal(A.underApiRoot(p), false, p)
  A.readServe(serveWith((v) => svg(v, '/mcp.svg')))
})

test('_headers: one rule for the asset prefix with every asset header once, one content type per extension, one rule per file; within Cloudflare\'s limits', () => {
  const text = A.headersFile(SERVE)
  const blocks = text.split('\n\n').map((b) => b.split('\n').filter((l) => l !== '' && !l.startsWith('#')))
  const rule = (pattern) => blocks.find((b) => b[0] === pattern)?.slice(1).map((l) => l.trim())
  assert.deepEqual(rule(`${SERVE.assetsPrefix}*`), Object.entries(SERVE.headers.asset).map(([k, v]) => `${k}: ${v}`))
  for (const [ext, type] of Object.entries(SERVE.contentTypes)) assert.deepEqual(rule(`${SERVE.assetsPrefix}*${ext}`), [`Content-Type: ${type}`])
  for (const f of SERVE.files) assert.deepEqual(rule(f), [...Object.entries(SERVE.headers.file).map(([k, v]) => `${k}: ${v}`), `Content-Type: ${SERVE.contentTypes[f.slice(f.lastIndexOf('.'))]}`])
  assert.equal(blocks.length, 1 + Object.keys(SERVE.contentTypes).length + SERVE.files.length)
  // No rule gives a document's headers to anything, and none covers a path outside the prefix and the files.
  assert.doesNotMatch(text, /Content-Security-Policy|no-cache/)
  for (const b of blocks) assert.ok(b[0].startsWith(SERVE.assetsPrefix) || SERVE.files.includes(b[0]), b[0])
  assert.ok(blocks.length <= A.HEADERS_MAX_RULES && text.split('\n').every((l) => l.length <= A.HEADERS_MAX_LINE))
  assert.deepEqual(A.assetsConfig('app'), { directory: 'app', html_handling: 'none', not_found_handling: 'none', run_worker_first: false })
})

// ───────────────────────── a build, read and staged ─────────────────────────

test('a build is read by serve.json\'s rules: index.html, hashed files under the prefix, the listed files; anything else is refused', () => {
  const b = A.readBuild(APP_FIXTURE, SERVE)
  assert.equal(b.document, readFileSync(join(APP_FIXTURE, 'index.html'), 'utf8'))
  assert.deepEqual(b.files.map((f) => f.path).sort(), [...readdirSync(join(APP_FIXTURE, 'assets')).map((f) => `/assets/${f}`), '/favicon.svg'].sort())
  assert.match(b.hash, /^[0-9a-f]{64}$/)
  assert.equal(A.readBuild(fixtureCopy(), SERVE).hash, b.hash, 'the same files give the same build hash')

  const refused = [
    ['no index.html', (d) => rmSync(join(d, 'index.html')), /no index\.html: the app's build is missing/],
    ['a file serve.json does not cover', (d) => writeFileSync(join(d, 'robots.txt'), 'x'), /robots\.txt: the build has a file app\/serve\.json does not say how to serve/],
    ['a source map (no content type)', (d) => writeFileSync(join(d, 'assets', 'index-Fx1EntrY.js.map'), '{}'), /names no content type for \.map/],
    ['a dot file', (d) => writeFileSync(join(d, 'assets', '.env.js'), 'x'), /not a plain file name/],
    ['a second page', (d) => writeFileSync(join(d, 'explore.html'), '<p>'), /explore\.html: the build has a file/],
    ['the icon missing', (d) => rmSync(join(d, 'favicon.svg')), /\/favicon\.svg is listed in app\/serve\.json but not in the build|asks for \/favicon\.svg/],
    ['no assets', (d) => rmSync(join(d, 'assets'), { recursive: true }), /nothing under \/assets\/|which the build does not hold/],
    ['a document of another build (it asks for a file that is not there)', (d) => writeFileSync(join(d, 'index.html'), readFileSync(join(d, 'index.html'), 'utf8').replace('index-Fx1EntrY.js', 'index-OLDBUILD.js')), /asks for \/assets\/index-OLDBUILD\.js, which the build does not hold/],
    ['a document asking another origin', (d) => writeFileSync(join(d, 'index.html'), readFileSync(join(d, 'index.html'), 'utf8').replace('</head>', '<script src="https://cdn.example/x.js"></script></head>')), /asks for https:\/\/cdn\.example\/x\.js/],
    ['an inline script', (d) => writeFileSync(join(d, 'index.html'), readFileSync(join(d, 'index.html'), 'utf8').replace('</head>', '<script>alert(1)</script></head>')), /inline script/],
    // n-3: a reference that is not double-quoted would pass unread.
    ['a single-quoted reference to another origin', (d) => writeFileSync(join(d, 'index.html'), readFileSync(join(d, 'index.html'), 'utf8').replace('</head>', "<script src='https://cdn.example/x.js'></script></head>")), /a reference that is not double-quoted/],
    ['an unquoted reference', (d) => writeFileSync(join(d, 'index.html'), readFileSync(join(d, 'index.html'), 'utf8').replace('</head>', '<link rel=stylesheet href=//cdn.example/x.css></head>')), /a reference that is not double-quoted/],
    ['a reference with spaces around the equals sign', (d) => writeFileSync(join(d, 'index.html'), readFileSync(join(d, 'index.html'), 'utf8').replace('</head>', '<script src = "https://cdn.example/x.js"></script></head>')), /asks for https:\/\/cdn\.example\/x\.js/],
    ['a link instead of a file', (d) => symlinkSync('/etc/hostname', join(d, 'assets', 'host-AAAAAAAA.js')), /not a regular file/],
  ]
  for (const [what, change, why] of refused) {
    const d = fixtureCopy()
    change(d)
    assert.throws(() => A.readBuild(d, SERVE), why, what)
  }
})

test('staging: the build\'s files and _headers, never index.html; the document goes into VIZ_APP with serve.json\'s document headers', () => {
  const out = join(scratch('staged'), 'app')
  const b = A.readBuild(APP_FIXTURE, SERVE)
  const s = A.stageBuild({ dist: APP_FIXTURE, build: b, serve: SERVE, outDir: out })
  assert.equal(existsSync(join(out, 'index.html')), false)
  assert.equal(readFileSync(join(out, '_headers'), 'utf8'), A.headersFile(SERVE))
  for (const f of b.files) assert.deepEqual(readFileSync(join(out, f.path.slice(1))), readFileSync(join(APP_FIXTURE, f.path.slice(1))))
  assert.equal(s.files, b.files.length + 1)
  assert.equal(A.hashStaged(out).hash, s.hash)
  writeFileSync(join(out, 'assets', 'index-Fx1EntrY.js'), 'changed')
  assert.notEqual(A.hashStaged(out).hash, s.hash)

  // A kept file never replaces a file of the build itself, whatever the caller hands in.
  const own = b.files.find((f) => f.path.endsWith('.js'))
  A.stageBuild({ dist: APP_FIXTURE, build: b, serve: SERVE, outDir: out, kept: [{ path: own.path, sha256: 'x', age: 1, body: Buffer.from('older bytes under the same name') }, { path: '/assets/index-OLD00001.js', sha256: 'y', age: 1, body: Buffer.from('old') }] })
  assert.deepEqual(readFileSync(join(out, own.path.slice(1))), readFileSync(join(APP_FIXTURE, own.path.slice(1))))
  assert.equal(readFileSync(join(out, 'assets', 'index-OLD00001.js'), 'utf8'), 'old')

  const v = JSON.parse(A.appVar(SERVE, b))
  assert.deepEqual(Object.keys(v).sort(), ['build', 'document', 'documents', 'etag', 'headers', 'v'])
  assert.deepEqual([v.v, v.build, v.documents, v.headers, v.document], [1, b.hash, SERVE.documents, SERVE.headers.document, b.document])
  assert.equal(v.etag, A.documentEtag(b.documentSha256, SERVE))
  assert.match(v.etag, /^"[0-9a-f]{32}"$/)
  // m-3: the entity tag and the build hash cover the document's headers. A release that only
  // tightens the policy is another build with another tag: a revalidation gets 200 and the new headers.
  const tighter = A.readServe(serveWith((x) => (x.headers.document['Content-Security-Policy'] += '; object-src \'none\'')))
  const b2 = A.readBuild(APP_FIXTURE, tighter)
  assert.equal(b2.documentSha256, b.documentSha256, 'the same bytes')
  assert.notEqual(A.documentEtag(b2.documentSha256, tighter), v.etag, 'another entity tag')
  assert.notEqual(JSON.parse(A.appVar(tighter, b2)).etag, v.etag)
  assert.notEqual(b2.hash, b.hash, 'another build')
  for (const change of [(x) => (x.headers.asset['Cache-Control'] = 'public, max-age=600'), (x) => (x.headers.file['Cache-Control'] = 'no-cache'), (x) => (x.contentTypes['.svg'] = 'image/svg+xml; charset=utf-8'), (x) => x.documents.push('/another')]) {
    assert.notEqual(A.readBuild(APP_FIXTURE, A.readServe(serveWith(change))).hash, b.hash, 'a rule a browser can tell apart is part of the build')
  }
  // Only the comment changed: the same rules, the same build, the same tag.
  const commented = A.readServe(serveWith((x) => (x.comment = 'another comment')))
  assert.notEqual(commented.sha256, SERVE.sha256)
  assert.deepEqual([commented.rules, A.readBuild(APP_FIXTURE, commented).hash, A.documentEtag(b.documentSha256, commented)], [SERVE.rules, b.hash, v.etag])
  // A document that has outgrown a Worker variable (5 KB) is refused, not truncated.
  assert.throws(() => A.appVar(SERVE, { ...b, document: `${b.document}<!--${'x'.repeat(5000)}-->` }), /a Worker variable holds 5 KB/)
})

// ───────────────────────── files of earlier builds ─────────────────────────

const H = (c) => c.repeat(64)
const buildOf = (hash, files) => ({ hash, files: Object.entries(files).map(([path, sha256]) => ({ path, sha256, bytes: 1 })) })

test('VIZ_APP_FILES names every file of a version with its SHA-256 and is read back; it never exceeds a Worker variable', () => {
  const b = A.readBuild(APP_FIXTURE, SERVE)
  const kept = [{ path: '/assets/index-OLD00001.js', sha256: H('a'), age: 1 }, { path: '/assets/index-OLD00002.js', sha256: H('b'), age: 2 }]
  const { text, kept: fits } = A.appFilesVar(b, kept)
  assert.equal(fits.length, 2)
  const back = A.parseAppFiles(text)
  assert.equal(back.build, b.hash)
  assert.deepEqual([...back.files], b.files.map((f) => [f.path, f.sha256]))
  assert.deepEqual(back.kept, kept)
  // Too many kept files: the oldest are left out until it fits.
  const many = Array.from({ length: 200 }, (_, i) => ({ path: `/assets/chunk-${String(i).padStart(8, '0')}.js`, sha256: H('c'), age: 1 + (i % 3) }))
  const big = A.appFilesVar(b, many)
  assert.ok(Buffer.byteLength(big.text) <= A.VAR_MAX_BYTES)
  assert.ok(big.kept.length > 10 && big.kept.length < 200)
  assert.ok(Math.max(...big.kept.map((k) => k.age)) <= Math.min(...many.filter((m) => !big.kept.some((k) => k.path === m.path)).map((m) => m.age)), 'the oldest go first')
  // A build whose own files do not fit names none: the next release can keep nothing, and says so.
  const huge = buildOf(H('d'), Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`/assets/chunk-${String(i).padStart(8, '0')}.js`, H('e')])))
  const none = A.appFilesVar(huge, kept)
  assert.ok(Buffer.byteLength(none.text) <= A.VAR_MAX_BYTES)
  assert.deepEqual([A.parseAppFiles(none.text).files, none.kept], [null, []])
  // m-5: and it says so, for the caller to say loudly.
  assert.deepEqual([none.named, big.named, A.appFilesVar(b, kept).named], [false, true, true])
  assert.ok(none.ownBytes > A.VAR_MAX_BYTES)
  // m-6: the day a kept file stopped being current travels with it.
  const dated = [{ path: '/assets/index-OLD00001.js', sha256: H('a'), age: 1, since: 20784 }]
  assert.deepEqual(A.parseAppFiles(A.appFilesVar(b, dated).text).kept, dated)
  for (const bad of [undefined, '', 'x', '{}', '{"v":2,"build":"x"}']) assert.equal(A.parseAppFiles(bad), null)
})

test('which files a new build keeps: those the serving build had and it has not, for keep_builds builds; nothing but hashed assets of a known type', () => {
  const serving = { build: H('1'), files: new Map([['/assets/index-AAAAAAAA.js', H('a')], ['/assets/Editor-BBBBBBBB.js', H('b')], ['/assets/Sans-CCCCCCCC.woff2', H('c')], ['/favicon.svg', H('f')]]), kept: [{ path: '/assets/index-OLD00001.js', sha256: H('d'), age: 1 }, { path: '/assets/index-OLD00003.js', sha256: H('e'), age: 3 }] }
  const next = buildOf(H('2'), { '/assets/index-NEWNEWNE.js': H('9'), '/assets/Sans-CCCCCCCC.woff2': H('c'), '/favicon.svg': H('f') })
  const DAY = 86_400_000
  const now = 20_000 * DAY + 5000
  const at = { now, keepDays: 30 }
  assert.deepEqual(A.carryPlan(serving, next, SERVE, 3, at), [
    { path: '/assets/Editor-BBBBBBBB.js', sha256: H('b'), age: 1, since: 20_000 },
    { path: '/assets/index-AAAAAAAA.js', sha256: H('a'), age: 1, since: 20_000 },
    // Kept by a version that named no day: it counts from today.
    { path: '/assets/index-OLD00001.js', sha256: H('d'), age: 2, since: 20_000 },
  ])
  // m-6: a bound in time. A kept file leaves `keep_days` after it stopped being current, whatever
  // the count of builds since, also at a release that does not change the app (the same build).
  const old = { ...serving, kept: [{ path: '/assets/index-OLD00001.js', sha256: H('d'), age: 1, since: 20_000 - 30 }, { path: '/assets/index-OLD00002.js', sha256: H('e'), age: 1, since: 20_000 - 31 }, { path: '/assets/index-OLD00004.js', sha256: H('e'), age: 2, since: 20_000 + 400 }, { path: '/assets/index-OLD00005.js', sha256: H('e'), age: 2, since: 'x' }] }
  const sameAgain = buildOf(H('1'), Object.fromEntries(serving.files))
  assert.deepEqual(A.carryPlan(old, sameAgain, SERVE, 3, at).map((f) => [f.path, f.age, f.since]), [
    ['/assets/index-OLD00001.js', 1, 20_000 - 30],
    // A day in the future, or no day at all, is data read from an account: it counts as today, so it cannot outlive keep_days from now.
    ['/assets/index-OLD00004.js', 2, 20_000],
    ['/assets/index-OLD00005.js', 2, 20_000],
  ])
  assert.deepEqual(A.carryPlan(old, sameAgain, SERVE, 3, { now, keepDays: 1 }).map((f) => f.path), ['/assets/index-OLD00004.js', '/assets/index-OLD00005.js'])
  // The next release reads what this one wrote (every entry now carries its day): thirty-one days later, changing nothing, they are gone.
  const written = { ...old, kept: A.carryPlan(old, sameAgain, SERVE, 3, at) }
  assert.deepEqual(A.carryPlan(written, sameAgain, SERVE, 3, { now: now + 30 * DAY, keepDays: 30 }).map((f) => f.path), ['/assets/index-OLD00004.js', '/assets/index-OLD00005.js'])
  assert.deepEqual(A.carryPlan(written, sameAgain, SERVE, 3, { now: now + 31 * DAY, keepDays: 30 }).map((f) => f.path), [], 'thirty-one days later, at a release that changes nothing, they are gone')
  assert.equal(A.appBlock({ name: 'w', app: { dir: 'app', serve: 'app/serve.json' } }).keepDays, 30)
  assert.equal(A.appWorker(PLAN).app.keepDays, 30)
  assert.throws(() => A.appBlock({ name: 'w', app: { dir: 'app', serve: 'app/serve.json', keep_days: 0 } }), /keep_days must be an integer from 1 to 365/)
  assert.deepEqual(A.carryPlan(serving, next, SERVE, 1).map((f) => f.path), ['/assets/Editor-BBBBBBBB.js', '/assets/index-AAAAAAAA.js'])
  assert.deepEqual(A.carryPlan(serving, next, SERVE, 0), [])
  assert.deepEqual(A.carryPlan(null, next, SERVE, 3), [])
  // The same build again (a release that did not change the app): what was kept stays as old as it was.
  const same = buildOf(H('1'), Object.fromEntries(serving.files))
  assert.deepEqual(A.carryPlan(serving, same, SERVE, 3, at), [{ path: '/assets/index-OLD00001.js', sha256: H('d'), age: 1, since: 20_000 }, { path: '/assets/index-OLD00003.js', sha256: H('e'), age: 3, since: 20_000 }])
  // A kept file that the new build has again is the build's own.
  assert.deepEqual(A.carryPlan(serving, buildOf(H('3'), { '/assets/index-OLD00001.js': H('d') }), SERVE, 3).map((f) => f.path).includes('/assets/index-OLD00001.js'), false)
  // A version whose variable names something else (it is data read from an account) keeps none of it.
  const hostile = { build: H('1'), files: new Map([['/index.html', H('a')], ['/assets/../index.html', H('a')], ['/assets/x.html', H('a')], ['/assets/.env.js', H('a')], ['/api/v1/query', H('a')], ['/assets/ok-AAAAAAAA.js', 'not-a-hash'], ['/assets/a%2Fb.js', H('a')]]), kept: [{ path: '/assets/old-AAAAAAAA.js', sha256: H('a'), age: 'x' }, { path: '/assets/old-BBBBBBBB.js', sha256: H('a'), age: 0 }] }
  assert.deepEqual(A.carryPlan(hostile, next, SERVE, 3), [])
})

test('a kept file is fetched from the deployment serving now and kept only with the recorded bytes; one that cannot be had is dropped, never a failure', async () => {
  const body = Buffer.from('console.log("old chunk")')
  const sha = (b) => execFileSync('sha256sum', { input: b, encoding: 'utf8' }).slice(0, 64)
  const plan = [
    { path: '/assets/Editor-BBBBBBBB.js', sha256: sha(body), age: 1 },
    { path: '/assets/index-AAAAAAAA.js', sha256: H('a'), age: 1 },
    { path: '/assets/gone-CCCCCCCC.js', sha256: H('c'), age: 2 },
    { path: '/assets/slow-DDDDDDDD.js', sha256: H('d'), age: 2 },
  ]
  const asked = []
  const fetchFile = async (url) => {
    asked.push(url)
    if (url.endsWith('gone-CCCCCCCC.js')) throw new Error('HTTP 404')
    if (url.endsWith('slow-DDDDDDDD.js')) throw new Error('The operation was aborted due to timeout')
    return url.endsWith('index-AAAAAAAA.js') ? Buffer.from('<!doctype html>not the chunk') : body
  }
  const r = await A.fetchKept(plan, 'https://vis.bitcru.sh', { fetchFile })
  assert.deepEqual(asked, plan.map((f) => `https://vis.bitcru.sh${f.path}`))
  assert.deepEqual(r.kept.map((k) => [k.path, k.age, k.body.equals(body)]), [['/assets/Editor-BBBBBBBB.js', 1, true]])
  assert.deepEqual(r.dropped, [
    { path: '/assets/index-AAAAAAAA.js', why: 'its bytes are not the ones recorded' },
    { path: '/assets/gone-CCCCCCCC.js', why: 'HTTP 404' },
    { path: '/assets/slow-DDDDDDDD.js', why: 'The operation was aborted due to timeout' },
  ])
  // A file over Cloudflare's 25 MiB is not kept, even with the recorded bytes: its upload would fail the release.
  const huge = Buffer.alloc(A.ASSET_MAX_BYTES + 1, 0x61)
  const big = await A.fetchKept([{ path: '/assets/huge-EEEEEEEE.js', sha256: sha(huge), age: 1 }], 'https://vis.bitcru.sh', { fetchFile: async () => huge })
  // (Compared by count and by name: a failed comparison of a 25 MiB body would print it, and did exhaust memory under mutation.)
  assert.equal(big.kept.length, 0, 'a file over 25 MiB was kept')
  assert.deepEqual(big.dropped, [{ path: '/assets/huge-EEEEEEEE.js', why: `${A.ASSET_MAX_BYTES + 1} bytes` }])
})

test('what serves now is read for its files only when one version serves: two versions at once keep nothing (m-9)', async () => {
  const vars = (text) => ({ resources: { bindings: [{ type: 'plain_text', name: 'VIZ_APP_FILES', text }, { type: 'secret_text', name: 'VIZ_APP_FILES' }] } })
  const text = A.appFilesVar(buildOf(H('1'), { '/assets/index-AAAAAAAA.js': H('a') }), []).text
  const api = (versions) => ({ currentDeployment: async () => ({ versions }), versionInfo: async (_n, id) => (id === 'v1' ? vars(text) : vars(undefined)) })
  const one = await servingAppFiles('viz-gateway', api([{ version_id: 'v1', percentage: 100 }]))
  assert.deepEqual([one.versionId, one.files.build, [...one.files.files.keys()]], ['v1', H('1'), ['/assets/index-AAAAAAAA.js']])
  // A gradual deployment: which version a kept file would come from is not known, so none is kept, and the stamp says why.
  assert.deepEqual(await servingAppFiles('viz-gateway', api([{ version_id: 'v1', percentage: 50 }, { version_id: 'v2', percentage: 50 }])), { files: null, why: 'viz-gateway serves 2 versions at once' })
  assert.deepEqual(await servingAppFiles('viz-gateway', api([])), { files: null, why: 'viz-gateway serves nothing yet' })
  assert.deepEqual(await servingAppFiles('viz-gateway', { currentDeployment: async () => null }), { files: null, why: 'viz-gateway serves nothing yet' })
  assert.deepEqual(await servingAppFiles('viz-gateway', api([{ version_id: 'v2', percentage: 100 }])), { files: null, why: 'the viz-gateway serving now (v2) has no app' })
})

test('a kept file that does not fit VIZ_APP_FILES is not staged either: the directory, the variable and the stamp name the same files', () => {
  const t = scratch('fit')
  const many = Array.from({ length: 120 }, (_, i) => ({ path: `/assets/chunk-${String(i).padStart(8, '0')}.js`, sha256: H('c'), age: 1 + (i % 3), body: Buffer.from(`chunk ${i}`) }))
  const stamp = A.stampBuild({ targetDir: t, repoRoot: tmp, release: 'r1', target: 'stage-x', serveFile: SERVE_FILE, dist: APP_FIXTURE, sources: { hash: 'h', files: 0, commit: null, dirty: null, by: 'walk' }, via: 'prebuilt', kept: many })
  const inVar = A.parseAppFiles(stamp.vars.VIZ_APP_FILES).kept.map((k) => k.path).sort()
  const staged = readdirSync(join(t, 'app', 'assets')).filter((f) => f.startsWith('chunk-')).map((f) => `/assets/${f}`).sort()
  assert.ok(inVar.length > 10 && inVar.length < many.length, String(inVar.length))
  assert.deepEqual(staged, inVar)
  assert.deepEqual(stamp.kept.map((k) => k.path).sort(), inVar)
  assert.equal(stamp.dropped.length, many.length - inVar.length)
  assert.match(stamp.dropped[0].why, /VIZ_APP_FILES holds 4500 bytes/)
  assert.ok(Buffer.byteLength(stamp.vars.VIZ_APP_FILES) <= A.VAR_MAX_BYTES)
  assert.throws(() => A.stampBuild({ targetDir: t, repoRoot: tmp, release: 'r1', target: 'stage-x', serveFile: SERVE_FILE, dist: APP_FIXTURE, sources: {}, via: 'by hand' }), /via must be "export"/)
  assert.deepEqual(stamp.filesVar, { named: true, bytes: Buffer.byteLength(stamp.vars.VIZ_APP_FILES), ownBytes: stamp.filesVar.ownBytes, max: 4500 })

  // n-4: a kept path that needs a directory where the new build has a file (or the reverse) is dropped and named; the build does not fail.
  const own = A.readBuild(APP_FIXTURE, SERVE).files.find((f) => f.path.endsWith('.js')).path
  const clash = A.stampBuild({ targetDir: t, repoRoot: tmp, release: 'r1', target: 'stage-x', serveFile: SERVE_FILE, dist: APP_FIXTURE, sources: { hash: 'h', files: 0, commit: null, dirty: null, by: 'walk' }, via: 'prebuilt', kept: [{ path: `${own}/chunk.js`, sha256: H('c'), age: 1, body: Buffer.from('x') }, { path: '/assets/fine-AAAAAAAA.js', sha256: H('d'), age: 1, body: Buffer.from('y') }] })
  assert.deepEqual(clash.kept.map((k) => k.path), ['/assets/fine-AAAAAAAA.js'])
  assert.deepEqual(clash.dropped.map((d) => [d.path, /a file where this path needs a directory/.test(d.why)]), [[`${own}/chunk.js`, true]])
})

test('a build whose own file list does not fit VIZ_APP_FILES says so loudly: in the log, the stamp, the summary and the plan (m-5)', async () => {
  // A build of 200 chunks: more than a 5 kB variable names. The document asks for the usual files; the rest are lazy chunks.
  const d = fixtureCopy()
  for (let i = 0; i < 200; i++) writeFileSync(join(d, 'assets', `chunk-${String(i).padStart(8, '0')}.js`), `export const c = ${i}\n`)
  const t = toyRepo()
  const kept = [{ path: '/assets/index-OLD00001.js', sha256: H('a'), age: 1, body: Buffer.from('old') }]
  const stamp = A.stampBuild({ targetDir: scratch('big'), repoRoot: tmp, release: 'r1', target: 'stage-x', serveFile: SERVE_FILE, dist: d, sources: { hash: 'h', files: 0, commit: null, dirty: null, by: 'walk' }, via: 'prebuilt', kept })
  assert.equal(stamp.filesVar.named, false)
  assert.ok(stamp.filesVar.ownBytes > A.VAR_MAX_BYTES && Buffer.byteLength(stamp.vars.VIZ_APP_FILES) <= A.VAR_MAX_BYTES)
  assert.equal(A.parseAppFiles(stamp.vars.VIZ_APP_FILES).files, null)
  assert.deepEqual([stamp.kept, stamp.dropped.map((x) => x.path)], [[], ['/assets/index-OLD00001.js']])
  assert.match(stamp.dropped[0].why, /the build's own file list does not fit VIZ_APP_FILES \(\d+ of 4500 bytes\)/)
  assert.equal(A.appSummary(stamp).filesNamed, false)
  // app.mjs says it where the operator reads: a WARNING, with what is lost and when.
  const r = await captured(() => build({ stage: 'apptest', release: 'big-1', carry: false, dist: d, plan: t.plan, repoRoot: t.root }))
  assert.equal(r.result?.filesVar.named, false, r.log + (r.error?.stack ?? ''))
  assert.match(r.log, /WARNING: this build's own file list \(20[0-9] files, \d+ bytes\) does not fit VIZ_APP_FILES \(4500 bytes\), so this version names none of its files: the NEXT release can keep nothing of this build/)
  // And a build that fits says nothing of the kind.
  const fits = await captured(() => build({ stage: 'apptest', release: 'small-1', carry: false, dist: APP_FIXTURE, plan: t.plan, repoRoot: t.root }))
  assert.doesNotMatch(fits.log, /does not fit VIZ_APP_FILES/)
  assert.equal(fits.result.filesVar.named, true)
})

// ───────────────────────── sources, the export, the stamp ─────────────────────────

/** A small repository with an app that "builds" by copying a prepared build, as app/'s `npm run build` writes dist/. */
function toyRepo({ git = true } = {}) {
  const root = scratch('repo')
  const w = (p, text) => {
    mkdirSync(join(root, p, '..'), { recursive: true })
    writeFileSync(join(root, p), text)
  }
  cpSync(APP_FIXTURE, join(root, 'app', 'prepared'), { recursive: true })
  w('app/serve.json', readFileSync(SERVE_FILE, 'utf8'))
  w('app/src/main.ts', 'export const x = 1\n')
  // The build reads the design system's generated file, as the real one does, and fails without its sources.
  w('app/package.json', JSON.stringify({ name: 'toy-app', private: true, scripts: { build: 'node build.mjs' } }))
  // It also notes where it ran and which names in ITS OWN environment look like credentials (names only,
  // and whether any value is the test's dummy), into the file the test names: never a value, never another process's.
  w('app/build.mjs', "import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'\nif (!existsSync('../design-system/tokens.json')) throw new Error('no design system')\nif (existsSync('reviews') || existsSync('../design-system/dist/stale.css') || existsSync('local.env')) throw new Error('the export holds what a build is not made from')\nreadFileSync('src/main.ts')\nif (process.env.TOY_SEEN) writeFileSync(process.env.TOY_SEEN, JSON.stringify({ cwd: process.cwd(), linked: existsSync('node_modules'), names: Object.keys(process.env).filter((k) => /^(CLOUDFLARE_|CF_API|WRANGLER_|ACTIONS_|SMOKE_)|TOKEN|SECRET|PASSWORD|CREDENTIAL|(^|_)KEY($|_)/i.test(k)).sort(), dummy: Object.values(process.env).some((v) => v.includes('DUMMY-not-a-credential')) }))\nrmSync('dist', { recursive: true, force: true })\ncpSync('prepared', 'dist', { recursive: true })\n")
  w('app/reviews/shot.png', 'not a source')
  w('app/local.env', 'IGNORED=1\n')
  w('app/.gitignore', 'dist/\nnode_modules/\nlocal.env\n')
  w('design-system/tokens.json', '{}')
  w('design-system/dist/stale.css', 'generated, ignored')
  w('design-system/.gitignore', 'dist/\nnode_modules/\n')
  w('design-system/reviews/big.png', 'not a source')
  const plan = { domain: 'vis.example', workers: [{ name: 'viz-gateway', component: 'deploy/gateway', app: { dir: 'app', serve: 'app/serve.json', needs: ['design-system'], not_built_from: ['app/reviews', 'design-system/reviews'], keep_builds: 3 } }] }
  const g = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim()
  if (git) {
    g('init', '-q')
    g('add', '-A')
    g('commit', '-q', '-m', 'toy')
  }
  return { root, plan, app: A.appWorker(plan).app, g, head: git ? g('rev-parse', 'HEAD') : null, w }
}

test('sources: tracked and unignored files of app/ and what it needs, never ignored or generated files, never what no build reads; the hash follows every change', () => {
  for (const git of [true, false]) {
    const t = toyRepo({ git })
    const s = A.listSources(t.root, t.app)
    assert.equal(s.by, git ? 'git' : 'walk')
    const want = ['app/.gitignore', 'app/build.mjs', 'app/package.json', 'app/prepared/assets/Editor-Fx1LazyC.js', 'app/serve.json', 'app/src/main.ts', 'design-system/.gitignore', 'design-system/tokens.json']
    for (const f of want) assert.ok(s.files.includes(f), `${git ? 'git' : 'walk'}: ${f}`)
    for (const f of s.files) assert.doesNotMatch(f, /reviews\/|\/dist\/|node_modules/, f)
    // git knows what is ignored; without it only the dependency and output directories are known.
    assert.equal(s.files.includes('app/local.env'), !git)
    const h = A.hashSources(t.root, s.files)
    t.w('app/src/main.ts', 'export const x = 2\n')
    const s2 = A.listSources(t.root, t.app)
    assert.notEqual(A.hashSources(t.root, s2.files), h)
    if (git) assert.deepEqual([s.commit, s.dirty, s2.dirty, s2.dirtyFiles], [t.head, false, true, ['app/src/main.ts']])
    t.w('app/src/main.ts', 'export const x = 1\n')
    assert.equal(A.hashSources(t.root, A.listSources(t.root, t.app).files), h)
    t.w('design-system/new.css', 'a{}')
    assert.notEqual(A.hashSources(t.root, A.listSources(t.root, t.app).files), h, 'a new, untracked source counts')
    // What no build reads does not count.
    rmSync(join(t.root, 'design-system/new.css'))
    t.w('app/reviews/another.png', 'x')
    assert.equal(A.hashSources(t.root, A.listSources(t.root, t.app).files), h)
  }
  assert.throws(() => A.listSources(scratch('empty'), toyRepo().app), /app\/ is not in this checkout/)
})

test('sources: a link is never a source, with git or without; git is asked about THIS checkout whatever GIT_ variables are inherited (m-9)', () => {
  for (const git of [true, false]) {
    const t = toyRepo({ git })
    const before = A.listSources(t.root, t.app)
    const h = A.hashSources(t.root, before.files)
    // A link to a file outside the sources, and one to a file inside: neither is exported or hashed.
    symlinkSync('/etc/hostname', join(t.root, 'app', 'src', 'host.ts'))
    symlinkSync('main.ts', join(t.root, 'app', 'src', 'again.ts'))
    symlinkSync(join(t.root, 'app', 'reviews'), join(t.root, 'app', 'linked-dir'))
    const s = A.listSources(t.root, t.app)
    assert.deepEqual(s.files, before.files, git ? 'git' : 'walk')
    assert.equal(A.hashSources(t.root, s.files), h)
    for (const f of s.files) assert.doesNotMatch(f, /host\.ts|again\.ts|linked-dir/)
  }
  // An inherited GIT_DIR or GIT_WORK_TREE (a hook, an outer tool) would point git at another repository, or at none.
  const t = toyRepo()
  const other = toyRepo()
  const saved = { ...process.env }
  try {
    for (const env of [{ GIT_DIR: join(tmp, 'no-such-git-dir') }, { GIT_DIR: join(other.root, '.git'), GIT_WORK_TREE: other.root }, { GIT_INDEX_FILE: join(tmp, 'no-such-index') }]) {
      Object.assign(process.env, env)
      const s = A.listSources(t.root, t.app)
      assert.deepEqual([s.by, s.commit, s.dirty], ['git', t.head, false], JSON.stringify(Object.keys(env)))
      assert.ok(s.files.includes('app/src/main.ts'))
      for (const k of Object.keys(env)) delete process.env[k]
    }
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  }
})

test('app.mjs build: exports the sources, builds there (never in the checkout), stages and stamps; a failed build stages nothing', async () => {
  const t = toyRepo()
  const r = await captured(() => build({ stage: 'apptest', release: 'toy-1', carry: false, plan: t.plan, repoRoot: t.root }))
  assert.equal(r.error, undefined, `${r.error?.stack}\n${r.log}`)
  const stamp = r.result
  assert.equal(existsSync(join(t.root, 'app', 'dist')), false, 'nothing was built in the checkout')
  assert.equal(existsSync(join(GENERATED_DIR, 'stage-apptest', 'app-build')), false, 'nor under generated/')
  assert.deepEqual([stamp.release, stamp.target, stamp.via, stamp.install, stamp.sources.commit, stamp.sources.dirty], ['toy-1', 'stage-apptest', 'export', 'ci', t.head, false])
  assert.equal(stamp.build.hash, A.readBuild(APP_FIXTURE, SERVE).hash)
  assert.deepEqual(A.stampProblems({ targetDir: join(GENERATED_DIR, 'stage-apptest'), repoRoot: t.root, release: 'toy-1', target: 'stage-apptest', app: t.app, stage: 'apptest' }).problems, [])

  // The build fails (here: a source it needs is gone): nothing is staged for the release.
  rmSync(join(GENERATED_DIR, 'stage-apptest'), { recursive: true })
  rmSync(join(t.root, 'app', 'src', 'main.ts'))
  const failed = await captured(() => build({ stage: 'apptest', release: 'toy-2', carry: false, plan: t.plan, repoRoot: t.root }))
  assert.match(failed.error?.message ?? '', /npm run build failed/)
  assert.equal(A.readStamp(join(GENERATED_DIR, 'stage-apptest')), null)
  assert.equal(existsSync(join(GENERATED_DIR, 'stage-apptest', 'app')), false)
})

/** Runs `fn` with these variables in this process's environment, then puts it back. */
async function withEnv(vars, fn) {
  const saved = { ...process.env }
  Object.assign(process.env, vars)
  try {
    return await fn()
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  }
}
/** What the toy build noted about itself (see toyRepo): where it ran and what its own environment held. */
const seenBy = async (fn) => {
  const file = join(scratch('seen'), 'seen.json')
  const r = await withEnv({ TOY_SEEN: file }, () => captured(fn))
  return { ...r, seen: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null }
}
const inside = (p, dir) => realpathSync(p) === realpathSync(dir) || realpathSync(p).startsWith(`${realpathSync(dir)}${sep}`)

test('M-1: the build\'s own environment holds no credential (a dummy, here); stated plainly, that is not isolation, and `handover` refuses to run beside one', async () => {
  const t = toyRepo()
  // Dummies only. What is held here: the variable is not in the environment of the build command
  // (npm and what it runs). What is NOT held, and cannot be by removing a variable: that the build
  // could not read it from an ancestor process. The workflow's job boundary is what holds that.
  const dummies = { CLOUDFLARE_API_TOKEN: DUMMY, CLOUDFLARE_ACCOUNT_ID: DUMMY, CF_API_TOKEN: DUMMY, SMOKE_KEY: DUMMY, WRANGLER_SEND_METRICS: DUMMY, NPM_TOKEN: DUMMY, ACTIONS_RUNTIME_TOKEN: DUMMY, MY_SERVICE_SECRET: DUMMY, DB_PASSWORD: DUMMY, SIGNING_KEY: DUMMY, KEY_FILE: DUMMY }
  const r = await withEnv(dummies, () => seenBy(() => build({ stage: 'apptest', release: 'env-1', carry: false, plan: t.plan, repoRoot: t.root })))
  assert.equal(r.error, undefined, `${r.error?.stack}\n${r.log}`)
  assert.deepEqual([r.seen.names, r.seen.dummy], [[], false], 'no credential by name, and the dummy value nowhere in the build\'s environment')
  // The same list, as a function: what is removed and what is not.
  const kept = A.buildEnv({ PATH: '/bin', HOME: '/h', npm_config_cache: '/c', HTTPS_PROXY: 'http://p', KEYBOARD: 'us', MONKEY: '1', TOY_SEEN: 'f', ...dummies })
  assert.deepEqual(Object.keys(kept).sort(), ['HOME', 'HTTPS_PROXY', 'KEYBOARD', 'MONKEY', 'PATH', 'TOY_SEEN', 'npm_config_cache'])
  assert.deepEqual(A.credentialNames({ ...dummies, CLOUDFLARE_API_KEY: '' }), ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'SMOKE_KEY'])

  // handover is the part that runs third-party code: beside a credential it does not start.
  const out = join(scratch('handover'), 'h')
  for (const name of ['CLOUDFLARE_API_TOKEN', 'SMOKE_KEY', 'CF_API_TOKEN']) {
    const refused = await seenBy(() => handover({ stage: 'apptest', release: 'env-2', out, plan: t.plan, repoRoot: t.root, env: { PATH: process.env.PATH, [name]: DUMMY } }))
    assert.match(refused.error?.message ?? '', new RegExp(`must run where no credential is, but this environment holds ${name}\\.`))
    assert.doesNotMatch(refused.error.message + refused.log, new RegExp(DUMMY), 'the value is never printed')
    assert.deepEqual([refused.seen, existsSync(out)], [null, false], 'nothing was built')
  }
  const made = await seenBy(() => handover({ stage: 'apptest', release: 'env-2', out, plan: t.plan, repoRoot: t.root, env: { PATH: process.env.PATH } }))
  assert.equal(made.error, undefined, `${made.error?.stack}\n${made.log}`)
  assert.deepEqual(made.seen.names, [])
})

test('m-10: the export is built outside the checkout (and outside deploy/), so nothing is resolved by walking up into the repository; it is removed afterwards', async () => {
  const t = toyRepo()
  const r = await seenBy(() => build({ stage: 'apptest', release: 'out-1', carry: false, plan: t.plan, repoRoot: t.root }))
  assert.equal(r.error, undefined, `${r.error?.stack}\n${r.log}`)
  const cwd = r.seen.cwd
  // The directory is gone; judge its path by its parent, which still exists.
  const parent = join(cwd, '..', '..')
  assert.equal(existsSync(cwd), false, 'the export is removed once the build is read')
  for (const [what, dir] of [['the checkout it was built from', t.root], ['this repository', REPO_ROOT], ['deploy/', DEPLOY_DIR], ['generated/', GENERATED_DIR]]) assert.equal(inside(parent, dir), false, `${cwd} is inside ${what}`)
  assert.equal(inside(parent, tmpdir()), true)
  assert.match(cwd, /viz-app-build-[^/]+\/app$/)
  // A temporary directory that is itself inside the checkout is refused, not used.
  const within = join(t.root, 'tmp-inside')
  mkdirSync(within)
  assert.throws(() => A.exportAndBuild({ repoRoot: t.root, app: t.app, files: A.listSources(t.root, t.app).files, tmp: within }), /is inside the checkout .*the app is built outside it/)
  // A failed build leaves no export behind either.
  rmSync(join(t.root, 'app', 'src', 'main.ts'))
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith('viz-app-build-')).length
  assert.throws(() => A.exportAndBuild({ repoRoot: t.root, app: t.app, files: A.listSources(t.root, t.app).files }), /npm run build failed/)
  assert.equal(readdirSync(tmpdir()).filter((n) => n.startsWith('viz-app-build-')).length, before)
})

test('M-1: a build handed over by a job without secrets is taken as data and only when it verifies against this checkout: source hash, serve.json, every file\'s SHA-256', async () => {
  const t = toyRepo()
  const base = scratch('handed')
  const out = join(base, 'h')
  const made = await captured(() => handover({ release: t.head, out, plan: t.plan, repoRoot: t.root, env: { PATH: process.env.PATH } }))
  assert.equal(made.error, undefined, `${made.error?.stack}\n${made.log}`)
  const d = JSON.parse(readFileSync(join(out, 'build.json'), 'utf8'))
  assert.deepEqual([d.v, d.kind, d.release, d.install, d.sources.commit, d.sources.dirty, d.sources.by], [1, 'viz-app-build', t.head, 'ci', t.head, false, 'git'])
  assert.deepEqual(d.build.files.map((f) => f.path).sort(), A.readBuild(APP_FIXTURE, SERVE).files.map((f) => f.path).sort())
  assert.deepEqual(readdirSync(out).sort(), ['build.json', 'dist'])

  // Production, the release a commit: taken, and the stamp says how it came and that it was verified.
  const staged = await seenBy(() => build({ release: t.head, from: out, carry: false, plan: t.plan, repoRoot: t.root }))
  assert.equal(staged.error, undefined, `${staged.error?.stack}\n${staged.log}`)
  assert.equal(staged.seen, null, 'staging a handed-over build runs no build: no npm, no code of app/')
  const stamp = staged.result
  assert.deepEqual([stamp.via, stamp.install, stamp.handover.build, stamp.handover.sources, stamp.sources.hash], ['handover', 'ci', d.build.hash, d.sources.hash, d.sources.hash])
  assert.deepEqual(A.stampProblems({ targetDir: join(GENERATED_DIR, 'production'), repoRoot: t.root, release: t.head, target: 'production', app: t.app, stage: undefined }).problems, [])
  assert.match(staged.log, /handed over from .*each with the SHA-256 its description names/)

  // Every way it may not be what it says: refused, nothing staged.
  let n = 0
  const tampered = async (what, change, why, opts = {}) => {
    const dir = join(base, `t${++n}`)
    cpSync(out, dir, { recursive: true })
    const rewrite = (f) => writeFileSync(join(dir, 'build.json'), JSON.stringify(f(JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8')))))
    change(dir, rewrite)
    rmSync(join(GENERATED_DIR, 'production'), { recursive: true, force: true })
    const r = await seenBy(() => build({ release: t.head, from: dir, carry: false, plan: t.plan, repoRoot: t.root, ...opts }))
    assert.match(r.error?.message ?? '', why, `${what}: ${r.log}`)
    assert.match(r.error.message, /^the handed-over app build in .* is refused:/, what)
    assert.equal(A.readStamp(join(GENERATED_DIR, opts.stage ? `stage-${opts.stage}` : 'production')), null, `${what}: nothing staged`)
    assert.equal(r.seen, null, what)
  }
  const asset = (dir) => join(dir, 'dist', 'assets', 'index-Fx1EntrY.js')
  await tampered('a file altered after the build', (dir) => writeFileSync(asset(dir), 'evil()'), /\/assets\/index-Fx1EntrY\.js is not the file the description names \(its bytes differ\)/)
  await tampered('a file added', (dir) => writeFileSync(join(dir, 'dist', 'assets', 'extra-AAAAAAAA.js'), 'x'), /\/assets\/extra-AAAAAAAA\.js is in dist\/ and not in the description/)
  await tampered('a file removed (one the document does not name)', (dir) => rmSync(join(dir, 'dist', 'assets', 'Editor-Fx1LazyC.js')), /\/assets\/Editor-Fx1LazyC\.js is in the description and not in dist\//)
  await tampered('the document altered', (dir) => writeFileSync(join(dir, 'dist', 'index.html'), readFileSync(join(dir, 'dist', 'index.html'), 'utf8').replace('<title>viz</title>', '<title>viz!</title>')), /index\.html is not the document the description names/)
  await tampered('a link in dist/', (dir) => (rmSync(asset(dir)), symlinkSync('/etc/hostname', asset(dir))), /not a regular file/)
  await tampered('a file serve.json does not cover', (dir) => writeFileSync(join(dir, 'dist', 'robots.txt'), 'x'), /robots\.txt: the build has a file app\/serve\.json does not say how to serve/)
  await tampered('another release\'s build', (_d, rw) => rw((x) => ({ ...x, release: 'e'.repeat(40) })), /it was built for release e{40}, not /)
  await tampered('built from other sources', (_d, rw) => rw((x) => ({ ...x, sources: { ...x.sources, hash: '0'.repeat(64) } })), /it was built from other sources than this checkout holds \(source hash 000000000000, here [0-9a-f]{12}\)/)
  await tampered('built under another serve.json', (_d, rw) => rw((x) => ({ ...x, serve: { ...x.serve, sha256: '0'.repeat(64) } })), /built under another app\/serve\.json/)
  await tampered('it says another commit', (_d, rw) => rw((x) => ({ ...x, sources: { ...x.sources, commit: 'd'.repeat(40) } })), /it says it was built from commit d{40}, not /)
  await tampered('it says its sources were changed', (_d, rw) => rw((x) => ({ ...x, sources: { ...x.sources, dirty: true } })), /it says its sources differed from their commit/)
  await tampered('sources not listed by git', (_d, rw) => rw((x) => ({ ...x, sources: { ...x.sources, by: 'walk' } })), /its sources were not listed by git \(walk\)/)
  await tampered('dependencies linked, not installed', (_d, rw) => rw((x) => ({ ...x, install: 'linked' })), /its dependencies were not installed from the lockfiles \(install: linked\)/)
  await tampered('the description names another build hash', (_d, rw) => rw((x) => ({ ...x, build: { ...x.build, hash: 'f'.repeat(64) } })), /the build hash is [0-9a-f]{12}, and the description says f{12}/)
  await tampered('no description', (dir) => rmSync(join(dir, 'build.json')), /it has no build\.json/)
  await tampered('a description of something else', (_d, rw) => rw((x) => ({ ...x, kind: 'something' })), /not a description of an app build, version 1/)
  await tampered('no dist/', (dir) => rmSync(join(dir, 'dist'), { recursive: true }), /it has no dist\/ directory/)
  // The checkout moved on after the build was handed over (a stage, where a changed work tree is allowed): the hash no longer matches.
  rmSync(join(GENERATED_DIR, 'stage-apptest'), { recursive: true, force: true })
  const forStage = join(base, 'stage')
  const s1 = await captured(() => handover({ stage: 'apptest', release: 's-1', out: forStage, plan: t.plan, repoRoot: t.root, env: {} }))
  assert.equal(s1.error, undefined, s1.log)
  t.w('app/src/main.ts', 'export const x = 5\n')
  const stale = await captured(() => build({ stage: 'apptest', release: 's-1', from: forStage, carry: false, plan: t.plan, repoRoot: t.root }))
  assert.match(stale.error?.message ?? '', /it was built from other sources than this checkout holds/)
  // --from and --dist are not combined, and a bare dist/ is still a stage's only.
  const both = await captured(() => build({ stage: 'apptest', release: 's-1', from: forStage, dist: APP_FIXTURE, carry: false, plan: t.plan, repoRoot: t.root }))
  assert.match(both.error?.message ?? '', /--from and --dist are two different things/)
  // handover never replaces a directory that is not one of its own.
  const precious = scratch('precious')
  writeFileSync(join(precious, 'notes.txt'), 'x')
  t.g('checkout', '-q', '--', 'app/src/main.ts')
  const no = await captured(() => handover({ stage: 'apptest', release: 's-2', out: precious, plan: t.plan, repoRoot: t.root, env: {} }))
  assert.match(no.error?.message ?? '', /is not empty and holds no build\.json: refusing to replace/)
  assert.equal(readFileSync(join(precious, 'notes.txt'), 'utf8'), 'x')
})

test('m-1: production with a release that is a commit fails closed when git cannot read the checkout: nothing is built, handed over or accepted', async () => {
  const commit = 'f'.repeat(40)
  // A tree that is no work tree (a copy, an archive).
  const plain = toyRepo({ git: false })
  for (const run of [() => build({ release: commit, carry: false, plan: plain.plan, repoRoot: plain.root }), () => handover({ release: commit, out: join(scratch('h'), 'h'), plan: plain.plan, repoRoot: plain.root, env: {} })]) {
    const r = await seenBy(run)
    assert.match(r.error?.message ?? '', new RegExp(`the release is commit ${commit}, and git cannot read this checkout \\(git: .*\\): nothing shows its app sources to be that commit's\\. Refused rather than guessed`), r.log)
    assert.equal(r.seen, null, 'nothing was built')
  }
  assert.equal(A.readStamp(join(GENERATED_DIR, 'production')), null)
  // A work tree git refuses to read (here: no git on the PATH; on a runner, a checkout owned by another user).
  const t = toyRepo()
  const noGit = scratch('no-git-bin')
  const r = await withEnv({ PATH: noGit }, () => seenBy(() => build({ release: t.head, carry: false, plan: t.plan, repoRoot: t.root })))
  assert.match(r.error?.message ?? '', /git cannot read this checkout \(git: .*\)/)
  assert.equal(r.seen, null)
  // A stage, or a release that is no commit, may be built from such a tree; the stamp says how its sources were listed.
  // (Without git the walk takes what git would ignore, which the toy's build refuses to see: one more reason it is no production path.)
  const withIgnored = await captured(() => build({ stage: 'apptest', release: commit, carry: false, plan: plain.plan, repoRoot: plain.root }))
  assert.match(withIgnored.error?.message ?? '', /npm run build failed/)
  rmSync(join(plain.root, 'app', 'local.env'))
  const stage = await captured(() => build({ stage: 'apptest', release: commit, carry: false, plan: plain.plan, repoRoot: plain.root }))
  assert.deepEqual([stage.result?.sources.by, stage.result?.sources.commit], ['walk', null], stage.log + (stage.error?.stack ?? ''))
  const local = await captured(() => build({ release: 'local-1', carry: false, plan: plain.plan, repoRoot: plain.root }))
  assert.equal(local.result?.sources.by, 'walk', local.log + (local.error?.stack ?? ''))
  // The stamp of such a build is not production's for a commit either, however it got there: configure and release ask this.
  const dir = join(GENERATED_DIR, 'production')
  const stampFile = A.stampPath(dir)
  writeFileSync(stampFile, JSON.stringify({ ...JSON.parse(readFileSync(stampFile, 'utf8')), release: commit }))
  const problems = A.stampProblems({ targetDir: dir, repoRoot: plain.root, release: commit, target: 'production', app: plain.app, stage: undefined }).problems.join('\n')
  assert.match(problems, /git cannot read this checkout/)
  assert.match(problems, /the app was built from sources git did not list \(walk\)/)
  assert.deepEqual(A.sourceGateProblems({ by: 'walk', why: 'x' }, commit, 'apptest'), [])
  assert.deepEqual(A.sourceGateProblems({ by: 'walk', why: 'x' }, 'local-1', undefined), [])
})

test('m-2: a linked install (VIZ_SKIP_NPM_CI) is recorded as what it is, and refused for production when the release is a commit', async () => {
  const t = toyRepo()
  // Only a directory that is a package has packages to link: the toy's design-system/ is plain
  // sources (as dashboard/src is for the real app) and needs none; app/ without them is refused.
  const missing = await seenBy(() => build({ stage: 'apptest', release: 'link-0', carry: false, plan: t.plan, repoRoot: t.root, skipInstall: true }))
  assert.match(missing.error?.message ?? '', /^app\/node_modules is missing, and the install was to be skipped$/)
  mkdirSync(join(t.root, 'app', 'node_modules'))
  assert.equal(A.listSources(t.root, t.app).dirty, false, 'node_modules is ignored in the toy repository')
  const refused = await seenBy(() => build({ release: t.head, carry: false, plan: t.plan, repoRoot: t.root, skipInstall: true }))
  assert.match(refused.error?.message ?? '', /VIZ_SKIP_NPM_CI=1 would link the checkout's node_modules into the app's build instead of installing from its lockfiles: refused for production/)
  assert.equal(refused.seen, null, 'nothing was built')
  const handed = await seenBy(() => handover({ release: t.head, out: join(scratch('h'), 'h'), plan: t.plan, repoRoot: t.root, skipInstall: true, env: {} }))
  assert.match(handed.error?.message ?? '', /refused for production/)
  // A stage: built with the linked packages, and the stamp, the summary and the log say so.
  const stage = await seenBy(() => build({ stage: 'apptest', release: 'link-1', carry: false, plan: t.plan, repoRoot: t.root, skipInstall: true }))
  assert.equal(stage.error, undefined, `${stage.error?.stack}\n${stage.log}`)
  assert.deepEqual([stage.result.install, A.appSummary(stage.result).install, stage.seen.linked], ['linked', 'linked', true])
  assert.match(stage.log, /node_modules LINKED from the checkout/)
  assert.match(stage.log, /NOTE: this build's dependencies were not installed from the lockfiles \(install: linked\)/)
  const installed = await seenBy(() => build({ stage: 'apptest', release: 'link-2', carry: false, plan: t.plan, repoRoot: t.root }))
  assert.deepEqual([installed.result.install, installed.seen.linked], ['ci', false])
})

test('app.mjs build, production: the checkout must be the release\'s commit with unchanged sources; a build made elsewhere is not taken', async () => {
  const t = toyRepo()
  const other = 'f'.repeat(40)
  let r = await captured(() => build({ release: other, carry: false, plan: t.plan, repoRoot: t.root }))
  assert.match(r.error?.message ?? '', new RegExp(`the release is commit ${other}, and this checkout is at ${t.head}`))
  t.w('app/src/main.ts', 'export const x = 3\n')
  r = await captured(() => build({ release: t.head, carry: false, plan: t.plan, repoRoot: t.root }))
  assert.match(r.error?.message ?? '', /the app's sources differ from it in this checkout \(app\/src\/main\.ts\)/)
  r = await captured(() => build({ release: 'local-1', carry: false, dist: APP_FIXTURE, plan: t.plan, repoRoot: t.root }))
  assert.match(r.error?.message ?? '', /--dist is for a stage only/)
  assert.equal(A.readStamp(join(GENERATED_DIR, 'production')), null)
  t.g('checkout', '-q', '--', 'app/src/main.ts')
  r = await captured(() => build({ release: t.head, carry: false, plan: t.plan, repoRoot: t.root }))
  assert.equal(r.error, undefined, r.log)
  assert.deepEqual(A.stampProblems({ targetDir: join(GENERATED_DIR, 'production'), repoRoot: t.root, release: t.head, target: 'production', app: t.app, stage: undefined }).problems, [])
})

test('a stamp is refused when the build is missing, of another release, altered, stale against the sources or serve.json, or not built here for production', async () => {
  const t = toyRepo()
  const dir = join(GENERATED_DIR, 'production')
  const judge = (over = {}) => A.stampProblems({ targetDir: dir, repoRoot: t.root, release: t.head, target: 'production', app: t.app, stage: undefined, ...over }).problems
  assert.match(judge().join('\n'), /the app has not been built for this release: .*app\.json is missing\. Build it first \(node deploy\/app\.mjs build --release /)
  const made = await captured(() => build({ release: t.head, carry: false, plan: t.plan, repoRoot: t.root }))
  assert.equal(made.error, undefined, made.log)
  assert.deepEqual(judge(), [])
  const stampFile = A.stampPath(dir)
  const original = readFileSync(stampFile, 'utf8')
  const restore = () => writeFileSync(stampFile, original)

  // Another release's build left in generated/.
  assert.match(judge({ release: 'e'.repeat(40) }).join('\n'), /is of release [0-9a-f]{40}, not e{40}: stale/)
  assert.match(judge({ target: 'stage-x', stage: 'x' }).join('\n'), /staged for production, not stage-x/)
  // The staged directory changed after the stamp: a file altered, added, removed.
  const asset = join(dir, 'app', 'assets', 'index-Fx1EntrY.js')
  const bytes = readFileSync(asset)
  writeFileSync(asset, 'evil()')
  assert.match(judge().join('\n'), /is not what was built \(its files changed after the stamp was written\)/)
  writeFileSync(asset, bytes)
  assert.deepEqual(judge(), [])
  writeFileSync(join(dir, 'app', 'index.html'), '<p>')
  assert.match(judge().join('\n'), /is not what was built/)
  rmSync(join(dir, 'app', 'index.html'))
  rmSync(join(dir, 'app', '_headers'))
  assert.match(judge().join('\n'), /is not what was built/)
  writeFileSync(join(dir, 'app', '_headers'), A.headersFile(SERVE))
  assert.deepEqual(judge(), [])
  // The sources changed after the build: stale (and, for a release that is a commit, not that commit's).
  t.w('app/src/main.ts', 'export const x = 4\n')
  assert.match(judge().join('\n'), /the app's sources changed after it was built .*: the build is stale/)
  assert.match(judge().join('\n'), /the app's sources differ from it in this checkout/)
  t.g('checkout', '-q', '--', 'app/src/main.ts')
  assert.deepEqual(judge(), [])
  // A new commit after the build: the release named is no longer the checkout.
  t.w('design-system/tokens.json', '{"a":1}')
  t.g('commit', '-qam', 'tokens')
  const now = judge().join('\n')
  assert.match(now, /the build is stale/)
  assert.match(now, /and this checkout is at [0-9a-f]{40}/)
  t.g('reset', '-q', '--hard', t.head)
  assert.deepEqual(judge(), [])
  // serve.json changed after the build.
  t.w('app/serve.json', JSON.stringify({ ...RAW, documents: [...RAW.documents, '/another-page'] }))
  assert.match(judge().join('\n'), /app\/serve\.json changed after the app was built/)
  t.g('checkout', '-q', '--', 'app/serve.json')
  assert.deepEqual(judge(), [])
  // A build handed in is not production's; a stage may take one, and its stamp says so.
  writeFileSync(stampFile, JSON.stringify({ ...JSON.parse(original), via: 'prebuilt' }))
  assert.match(judge().join('\n'), /was not made by deploy\/app\.mjs from this checkout's sources \(it is "prebuilt"\)/)
  restore()
  writeFileSync(stampFile, JSON.stringify({ ...JSON.parse(original), v: 99 }))
  assert.match(judge().join('\n'), /not an app stamp of version 2/)
  restore()
  // m-9: the stamp describes the directory that would be uploaded, and no other. A stamp that names
  // another directory (here: a faithful copy elsewhere) is refused; and whatever it names, the
  // directory hashed is the one the config uploads.
  cpSync(join(dir, 'app'), join(t.root, 'elsewhere', 'app'), { recursive: true })
  const elsewhere = relative(t.root, join(t.root, 'elsewhere', 'app')).split(sep).join('/')
  writeFileSync(stampFile, JSON.stringify({ ...JSON.parse(original), staged: { ...JSON.parse(original).staged, dir: elsewhere } }))
  assert.match(judge().join('\n'), /the app stamp names elsewhere\/app, not .*: it describes another directory than the one that would be uploaded/)
  writeFileSync(asset, 'evil()')
  assert.match(judge().join('\n'), /is not what was built/, 'the uploaded directory is the one hashed, whatever the stamp names')
  writeFileSync(asset, bytes)
  restore()
  rmSync(join(t.root, 'elsewhere'), { recursive: true })
  assert.deepEqual(judge(), [])
  // m-2: a build whose dependencies were linked is not production's for a commit.
  writeFileSync(stampFile, JSON.stringify({ ...JSON.parse(original), install: 'linked' }))
  assert.match(judge().join('\n'), /the app's dependencies were not installed from its lockfiles \(install: linked;/)
  restore()
  // A build handed over and verified is production's; one of unknown kind is not.
  writeFileSync(stampFile, JSON.stringify({ ...JSON.parse(original), via: 'handover' }))
  assert.deepEqual(judge(), [])
  writeFileSync(stampFile, JSON.stringify({ ...JSON.parse(original), via: 'downloaded' }))
  assert.match(judge().join('\n'), /it is "downloaded"/)
  restore()
  rmSync(join(dir, 'app'), { recursive: true })
  assert.match(judge().join('\n'), /the staged app build .* is missing/)
  const pre = await captured(() => build({ stage: 'apptest', release: 'pre-1', carry: false, dist: APP_FIXTURE, plan: t.plan, repoRoot: t.root }))
  assert.equal(pre.result?.via, 'prebuilt', pre.log + (pre.error?.stack ?? ''))
  assert.deepEqual(A.stampProblems({ targetDir: join(GENERATED_DIR, 'stage-apptest'), repoRoot: t.root, release: 'pre-1', target: 'stage-apptest', app: t.app, stage: 'apptest' }).problems, [])
})

test('app.mjs build keeps the serving version\'s files the new build no longer has, from the deployment itself, verified; then ages and drops them', async () => {
  const t = toyRepo()
  const gw = 'viz-apptest-gateway'
  const origin = 'https://viz-apptest-gateway.acct.workers.dev'
  /** The deployment as a browser sees it: the files of the version serving now. */
  let live = new Map()
  const fetchFile = async (url) => {
    assert.ok(url.startsWith(`${origin}/assets/`), url)
    const b = live.get(url.slice(origin.length))
    if (!b) throw new Error('HTTP 404')
    return b
  }
  let version = null
  const api = {
    workersSubdomain: async () => 'acct',
    currentDeployment: async (name) => (name === gw && version ? { versions: [{ version_id: 'v', percentage: 100 }] } : null),
    versionInfo: async () => ({ resources: { bindings: Object.entries(version).map(([name, text]) => ({ type: 'plain_text', name, text })) } }),
  }
  process.env.CLOUDFLARE_API_TOKEN = 'fake-token-not-a-credential'
  /** Releases a build whose entry chunk and editor chunk are `tag`'s: the files a real build renames when their content changes. */
  const release = async (tag, opts = {}) => {
    const d = fixtureCopy()
    const rename = (from, to) => {
      writeFileSync(join(d, 'assets', to), `${readFileSync(join(d, 'assets', from), 'utf8')}// ${tag}\n`)
      rmSync(join(d, 'assets', from))
    }
    if (tag !== 'A') {
      rename('index-Fx1EntrY.js', `index-${tag.padEnd(8, 'x')}.js`)
      rename('Editor-Fx1LazyC.js', `Editor-${tag.padEnd(8, 'x')}.js`)
      writeFileSync(join(d, 'index.html'), readFileSync(join(d, 'index.html'), 'utf8').replace('index-Fx1EntrY.js', `index-${tag.padEnd(8, 'x')}.js`))
    }
    const r = await captured(() => build({ stage: 'apptest', release: `rel-${tag}`, dist: d, plan: t.plan, repoRoot: t.root, api, fetchFile, ...opts }))
    assert.equal(r.error, undefined, `${r.error?.stack}\n${r.log}`)
    // "Deploy" it: what serves now is this version's variables and its staged files.
    version = r.result.vars
    const staged = join(t.root, r.result.staged.dir)
    live = new Map(readdirSync(join(staged, 'assets')).map((f) => [`/assets/${f}`, readFileSync(join(staged, 'assets', f))]))
    return { stamp: r.result, log: r.log, names: [...live.keys()].sort() }
  }
  const a = await release('A')
  assert.deepEqual([a.stamp.kept, a.stamp.carry], [[], { skipped: 'viz-apptest-gateway serves nothing yet' }])
  // B replaces the entry and the editor chunk: A's are kept (age 1); the unchanged font, style and theme are simply B's own.
  const b = await release('B')
  assert.deepEqual(b.stamp.kept.map((k) => [k.path, k.age]), [['/assets/Editor-Fx1LazyC.js', 1], ['/assets/index-Fx1EntrY.js', 1]])
  assert.deepEqual(b.stamp.carry, { from: origin, servingVersion: 'v', servingBuild: a.stamp.build.hash, wanted: 2 })
  assert.ok(b.names.includes('/assets/Editor-Fx1LazyC.js') && b.names.includes('/assets/Editor-Bxxxxxxx.js'))
  assert.deepEqual(live.get('/assets/Editor-Fx1LazyC.js'), readFileSync(join(APP_FIXTURE, 'assets', 'Editor-Fx1LazyC.js')), 'a page of build A still gets A\'s chunk, byte for byte')
  assert.match(readFileSync(join(t.root, b.stamp.staged.dir, '_headers'), 'utf8'), /^\/assets\/\*$/m)
  // The same build released again: nothing ages.
  const b2 = await release('B')
  assert.deepEqual(b2.stamp.kept.map((k) => [k.path, k.age]), [['/assets/Editor-Fx1LazyC.js', 1], ['/assets/index-Fx1EntrY.js', 1]])
  const c = await release('C')
  assert.deepEqual(c.stamp.kept.map((k) => [k.path, k.age]), [['/assets/Editor-Bxxxxxxx.js', 1], ['/assets/index-Bxxxxxxx.js', 1], ['/assets/Editor-Fx1LazyC.js', 2], ['/assets/index-Fx1EntrY.js', 2]])
  await release('D')
  const e = await release('E')
  assert.deepEqual(e.stamp.kept.map((k) => k.age), [1, 1, 2, 2, 3, 3])
  assert.ok(!e.names.includes('/assets/Editor-Fx1LazyC.js'), 'A\'s files are gone after keep_builds (3) later builds')
  // A file whose bytes are not the recorded ones (the deployment answered something else), and one that is gone: dropped, named, not a failure.
  live.set('/assets/Editor-Dxxxxxxx.js', Buffer.from('<!doctype html>'))
  live.delete('/assets/index-Cxxxxxxx.js')
  const f = await release('F')
  assert.deepEqual(f.stamp.dropped, [{ path: '/assets/Editor-Dxxxxxxx.js', why: 'its bytes are not the ones recorded' }, { path: '/assets/index-Cxxxxxxx.js', why: 'HTTP 404' }])
  assert.ok(!f.names.includes('/assets/Editor-Dxxxxxxx.js') && !f.names.includes('/assets/index-Cxxxxxxx.js'))
  assert.match(f.log, /WARNING: \/assets\/Editor-Dxxxxxxx\.js of an earlier build is not kept \(its bytes are not the ones recorded\)/)
  // Asked not to (or with no credentials to read what serves): nothing is kept, and the stamp says why.
  const g = await release('G', { carry: false })
  assert.deepEqual([g.stamp.kept, g.stamp.carry], [[], { skipped: 'asked (--no-carry)' }])
  delete process.env.CLOUDFLARE_API_TOKEN
  const h = await release('H')
  assert.deepEqual([h.stamp.kept, h.stamp.carry], [[], { skipped: 'no Cloudflare credentials to read what serves now' }])
  process.env.CLOUDFLARE_API_TOKEN = 'fake-token-not-a-credential'

  // m-9: production asks its own domain for the kept files, never a workers.dev name; a stage asks its workers.dev name.
  const asked = []
  const prodApi = {
    workersSubdomain: async () => assert.fail('production never asks for the workers.dev subdomain'),
    currentDeployment: async (name) => (name === 'viz-gateway' ? { versions: [{ version_id: 'p', percentage: 100 }] } : null),
    versionInfo: async () => ({ resources: { bindings: [{ type: 'plain_text', name: 'VIZ_APP_FILES', text: A.appFilesVar(buildOf(H('7'), { '/assets/index-PRODOLD1.js': H('a') }), []).text }] } }),
  }
  const prod = await captured(() => build({ release: 'local-prod-1', plan: t.plan, repoRoot: t.root, api: prodApi, fetchFile: async (url) => (asked.push(url), Buffer.from('not the recorded bytes')) }))
  assert.equal(prod.error, undefined, `${prod.error?.stack}\n${prod.log}`)
  assert.deepEqual(asked, ['https://vis.example/assets/index-PRODOLD1.js'])
  assert.deepEqual([prod.result.carry.from, prod.result.target], ['https://vis.example', 'production'])

  // m-6: the plan's keep_days reaches the build: a file kept since longer ago is not even asked for.
  const DAY = 86_400_000
  const now = 20_000 * DAY
  const agedApi = { ...prodApi, versionInfo: async () => ({ resources: { bindings: [{ type: 'plain_text', name: 'VIZ_APP_FILES', text: A.appFilesVar(buildOf(H('7'), {}), [{ path: '/assets/index-FRESH001.js', sha256: H('a'), age: 1, since: 19_998 }, { path: '/assets/index-STALE001.js', sha256: H('b'), age: 1, since: 19_990 }]).text }] } }) }
  const days = (n) => ({ ...t.plan, workers: t.plan.workers.map((w) => ({ ...w, app: { ...w.app, keep_days: n } })) })
  for (const [n, want] of [[5, ['https://vis.example/assets/index-FRESH001.js']], [30, ['https://vis.example/assets/index-FRESH001.js', 'https://vis.example/assets/index-STALE001.js']], [1, []]]) {
    asked.length = 0
    const r = await captured(() => build({ release: 'local-prod-2', plan: days(n), repoRoot: t.root, api: agedApi, now, fetchFile: async (url) => (asked.push(url), Buffer.from('x')) }))
    assert.equal(r.error, undefined, `${r.error?.stack}\n${r.log}`)
    assert.deepEqual(asked, want, `keep_days ${n}`)
  }
})

// ───────────────────────── configure.mjs ─────────────────────────

const STAGE = 'apptest'
const RESOURCES = { kv_namespaces: { [`viz-${STAGE}-config`]: 'c'.repeat(32), 'viz-config': 'd'.repeat(32) }, ratelimit_namespaces: {} }
// A stage's PUBLIC_URL is its gateway's workers.dev URL (D75): a subdomain is given, as the account would.
const conf = (opts = {}) => configure({ stage: STAGE, release: 'r1', quiet: true, resources: RESOURCES, oauthWithoutRateLimits: true, workersSubdomain: 'example', ...opts })
const gatewayOf = (m) => m.workers.find((w) => w.canonical === 'viz-gateway')

test('configure: viz-gateway gets the staged build as its static assets (asset-first, exact paths) and the two vars; no other Worker gets either', () => {
  const { stamp } = appBuilt({ stage: STAGE, release: 'r1' })
  const m = conf()
  const gw = gatewayOf(m)
  const cfg = readJsonc(join(REPO_ROOT, gw.config))
  assert.deepEqual(cfg.assets, { directory: 'app', html_handling: 'none', not_found_handling: 'none', run_worker_first: false })
  assert.equal(cfg.assets.binding, undefined, 'the Worker needs no binding to the files')
  assert.equal(cfg.vars.VIZ_APP, stamp.vars.VIZ_APP)
  assert.equal(cfg.vars.VIZ_APP_FILES, stamp.vars.VIZ_APP_FILES)
  assert.deepEqual(JSON.parse(cfg.vars.VIZ_APP).documents, SERVE.documents)
  assert.deepEqual([gw.app.build, gw.app.files, gw.app.via, gw.app.serve.documents], [stamp.build.hash, stamp.build.files.length, 'export', SERVE.documents])
  assert.equal(m.withoutApp, false)
  for (const w of m.workers.filter((x) => x.deploy && x.canonical !== 'viz-gateway')) {
    const c = readJsonc(join(REPO_ROOT, w.config))
    assert.deepEqual([c.assets, c.vars.VIZ_APP, c.vars.VIZ_APP_FILES, w.app], [undefined, undefined, undefined, null], w.name)
  }
})

test('configure refuses a build that is missing, of another release or altered; a stage only goes without the app when asked, production never; a manifest that is never deployed leaves it out', () => {
  assert.throws(() => conf(), /viz-gateway serves the web app, and its build cannot be released:\n {2}- the app has not been built for this release/)
  appBuilt({ stage: STAGE, release: 'r0' })
  assert.throws(() => conf(), /is of release r0, not r1: stale/)
  appBuilt({ stage: STAGE, release: 'r1' })
  writeFileSync(join(GENERATED_DIR, `stage-${STAGE}`, 'app', 'assets', 'index-Fx1EntrY.js'), 'changed')
  assert.throws(() => conf(), /is not what was built/)
  rmSync(join(GENERATED_DIR, `stage-${STAGE}`), { recursive: true })

  const without = conf({ withoutApp: true })
  const cfg = readJsonc(join(REPO_ROOT, gatewayOf(without).config))
  assert.deepEqual([cfg.assets, cfg.vars.VIZ_APP, cfg.vars.VIZ_APP_FILES, gatewayOf(without).app, without.withoutApp], [undefined, undefined, undefined, { withoutApp: true }, true])
  assert.throws(() => configure({ release: 'r1', quiet: true, resources: RESOURCES, idsOptional: true, withoutApp: true }), /--without-app is for a stage only: production serves the web app/)

  const optional = conf({ idsOptional: true })
  assert.equal(gatewayOf(optional).app.notBuilt, true)
  assert.equal(readJsonc(join(REPO_ROOT, gatewayOf(optional).config)).assets, undefined)
  assert.equal(optional.idsOptional, true)
})

test('configure: only it sets the app\'s vars and `assets`: a component config or VIZ_STAGE_VARS that carries one is refused', () => {
  const worker = PLAN.workers.find((w) => w.name === 'viz-gateway')
  const base = readJsonc(join(REPO_ROOT, 'deploy/gateway/wrangler.jsonc'))
  const gen = (cfg, extra = {}) => generateWorker({ worker, cfg, componentDir: join(REPO_ROOT, 'deploy/gateway'), plan: PLAN, stage: STAGE, release: 'x', ids: {}, outDir: join(GENERATED_DIR, `stage-${STAGE}`), app: { withoutApp: true }, ...extra })
  assert.throws(() => gen({ ...base, assets: { directory: '../../app/dist', not_found_handling: 'single-page-application' } }), /"assets" is not something configure\.mjs knows how to deploy/)
  assert.throws(() => gen({ ...base, vars: { VIZ_APP: '{}' } }), /VIZ_APP is set by deploy\/configure\.mjs only/)
  assert.throws(() => gen(base, { extraVars: { VIZ_APP_FILES: '{}' } }), /VIZ_APP_FILES is set by deploy\/configure\.mjs only/)
  assert.throws(() => gen(base, { app: null }), /declares "app" in deploy\/workers\.json, and no app build/)
  const query = PLAN.workers.find((w) => w.name === 'viz-query')
  assert.throws(() => generateWorker({ worker: query, cfg: readJsonc(join(REPO_ROOT, 'query/wrangler.jsonc')), componentDir: join(REPO_ROOT, 'query'), plan: PLAN, stage: STAGE, release: 'x', ids: {}, idsOptional: true, outDir: GENERATED_DIR, app: { withoutApp: true } }), /an app build was given for viz-query/)
})

// ───────────────────────── release.mjs ─────────────────────────

const GW = 'viz-gateway'
const FORMATS = JSON.stringify({ v: 1, complete: true, formats: {} })
/**
 * One release of the gateway alone, for production (`stage` null) or a stage, written as configure.mjs
 * writes it. `app`: 'built' (the fixture, staged and stamped), 'without' (--without-app), or 'none'
 * (a manifest that says nothing: as a configure.mjs that forgot the app would write it).
 */
function release(name, { stage = null, app = 'built', dist, config: change = (c) => c, entry = (e) => e, manifest: extra = {} } = {}) {
  const N = stage ? `viz-${stage}-gateway` : GW
  const target = stage ? `stage-${stage}` : 'production'
  const dir = join(GENERATED_DIR, target)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${GW}.jsonc`)
  const built = app === 'built' ? appBuilt({ stage, release: name, configFile: file, ...(dist ? { dist } : {}) }) : null
  const cfg = change({ name: N, ...(built ? { assets: built.config.assets } : {}), vars: { VIZ_RELEASE: name, VIZ_WORKER: GW, VIZ_FORMATS: FORMATS, ...(built?.config.vars ?? {}) } })
  writeFileSync(file, JSON.stringify(cfg))
  const w = entry({ name: N, canonical: GW, component: 'deploy/gateway', config: relative(REPO_ROOT, file), deploy: true, public: true, migrationTags: [], migrationTag: null, schemas: [], formats: [], floors: [], ...(built ? built.manifest : app === 'without' ? WITHOUT_APP.worker : {}) })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ target, stage, release: name, durableObjectsCodeUpdate: 'deferred 30s', order: [N], releaseFrom: N, workers: [w], ...(app === 'without' ? WITHOUT_APP.manifest : {}), ...extra }))
  return { name: N, stage: stage ?? undefined, built, dir }
}
/** An account where the gateway serves a version from before the app (as fb77292's does). */
const serves = (name = GW) => writeState({ calls: [], counter: 100, workers: { [name]: { migrationTag: null, versions: [{ id: '00000000-0000-4000-8000-00000000000b', number: 1, tag: 'old', vars: { VIZ_RELEASE: 'old', VIZ_FORMATS: FORMATS }, secrets: {} }], deployment: [{ version_id: '00000000-0000-4000-8000-00000000000b', percentage: 100 }] } } })
const ship = (stage, opts = { appStageOverride: NO_STAGE }) => captured(() => deploy({ stage, ...opts }))
const uploads = () => readState().calls.filter((c) => c.argv[0] === 'versions' || c.argv[0] === 'deploy' || c.argv[0] === 'triggers')

test('release: production goes out with the staged build; the uploaded version carries the document and the file list, and the record names the build', async () => {
  serves()
  const r = release('rel-1')
  const plan = await captured(() => planOnly({ stage: undefined, appStageOverride: NO_STAGE }))
  assert.equal(plan.result?.exit, 0, plan.log)
  assert.match(plan.log, new RegExp(`web app on viz-gateway: build ${r.built.stamp.build.hash.slice(0, 12)}, ${r.built.stamp.build.files.length} files; serving now: no app`))
  assert.deepEqual(uploads(), [], 'a plan uploads nothing')
  const out = await ship()
  assert.equal(out.result?.exit, 0, out.log + (out.error?.stack ?? ''))
  const v = serving(readState(), GW)
  assert.equal(v.vars.VIZ_APP, r.built.stamp.vars.VIZ_APP)
  assert.equal(A.parseAppFiles(v.vars.VIZ_APP_FILES).build, r.built.stamp.build.hash)
  const rec = out.result.record
  assert.deepEqual(rec.app.map((a) => [a.worker, a.build, a.files, a.via, a.document.sha256]), [[GW, r.built.stamp.build.hash, r.built.stamp.build.files.length, 'export', r.built.stamp.build.document.sha256]])
  assert.equal(rec.withoutApp, false)
  assert.deepEqual(out.result.previous.app, [], 'what served before had no app')
  // The upload names the generated config, whose `assets` is the staged directory.
  const upload = callsLike(readState(), 'versions upload')[0]
  assert.deepEqual(readJsonc(upload.argv[upload.argv.indexOf('--config') + 1]).assets, { directory: 'app', html_handling: 'none', not_found_handling: 'none', run_worker_first: false })
  // The next release sees it serving.
  release('rel-2')
  const next = await captured(() => planOnly({ stage: undefined }))
  assert.match(next.log, /serving now: the same build/)
  assert.equal(next.result?.exit, 0, 'the app serves already: no stage is asked for again')
  // The record says how the build came and how its dependencies were installed.
  assert.deepEqual([rec.app[0].install, rec.app[0].filesNamed, rec.app[0].handover, typeof rec.app[0].serving], ['ci', true, null, 'string'])
})

test('release: a missing, stale or altered build is refused (exit 3) before anything is uploaded', async () => {
  const refused = async (what, prepare, why, stage) => {
    serves(stage ? `viz-${stage}-gateway` : GW)
    prepare()
    const before = readState().calls.length
    for (const run of [() => planOnly({ stage, appStageOverride: NO_STAGE }), () => deploy({ stage, appStageOverride: NO_STAGE })]) {
      const out = await captured(run)
      assert.equal(out.result?.exit, 3, `${what}: ${out.log}${out.error?.stack ?? ''}`)
      assert.match(out.log, why, what)
    }
    assert.match((await ship(stage)).log, /REFUSED before uploading or promoting anything/)
    assert.deepEqual(readState().calls.slice(before).map(cmd), [], `${what}: nothing uploaded`)
    rmSync(GENERATED_DIR, { recursive: true, force: true })
  }
  const dir = join(GENERATED_DIR, 'production')
  const stamp = () => JSON.parse(readFileSync(A.stampPath(dir), 'utf8'))
  await refused('no stamp', () => (release('rel-1'), rmSync(A.stampPath(dir))), /the app has not been built for this release/)
  await refused('no staged directory', () => (release('rel-1'), rmSync(join(dir, 'app'), { recursive: true })), /the staged app build .* is missing/)
  await refused('another release\'s build', () => (release('rel-0'), writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')), release: 'rel-1' }))), /is of release rel-0, not rel-1: stale/)
  await refused('the sources changed after the build', () => (release('rel-1'), writeFileSync(A.stampPath(dir), JSON.stringify({ ...stamp(), sources: { ...stamp().sources, hash: '0'.repeat(64) } }))), /the app's sources changed after it was built .*: the build is stale/)
  await refused('serve.json changed after the build', () => (release('rel-1'), writeFileSync(A.stampPath(dir), JSON.stringify({ ...stamp(), serve: { ...stamp().serve, sha256: '0'.repeat(64) } }))), /app\/serve\.json changed after the app was built/)
  await refused('a staged file altered', () => (release('rel-1'), writeFileSync(join(dir, 'app', 'assets', 'index-Fx1EntrY.js'), 'evil()')), /is not what was built/)
  await refused('index.html put among the assets', () => (release('rel-1'), writeFileSync(join(dir, 'app', 'index.html'), '<p>')), /is not what was built/)
  await refused('_headers removed', () => (release('rel-1'), rmSync(join(dir, 'app', '_headers'))), /is not what was built/)
  await refused('a build handed in, for production', () => (release('rel-1'), writeFileSync(A.stampPath(dir), JSON.stringify({ ...stamp(), via: 'prebuilt' }))), /was not made by deploy\/app\.mjs from this checkout's sources/)
  await refused('a manifest that says nothing of the app', () => release('rel-1', { app: 'none' }), /viz-gateway serves the web app, and its manifest says nothing of a build/)
  await refused('a manifest whose build was left out', () => release('rel-1', { app: 'none', entry: (e) => ({ ...e, app: { notBuilt: true, why: 'x' } }) }), /left the build out \(x\)/)
  await refused('production without the app', () => release('rel-1', { app: 'without' }), /only a stage configured --without-app may be: production serves the web app/)
  await refused('a stage "without", not configured so', () => release('rel-1', { stage: 'apptest', app: 'none', entry: (e) => ({ ...e, ...WITHOUT_APP.worker }) }), /only a stage configured --without-app may be/, 'apptest')
  await refused('a stage "without" whose config still uploads assets', () => release('rel-1', { stage: 'apptest', app: 'without', config: (c) => ({ ...c, assets: { directory: 'app' } }) }), /configured --without-app, but its generated config carries "assets"/, 'apptest')
  await refused('a config that uploads another directory', () => release('rel-1', { config: (c) => ({ ...c, assets: { ...c.assets, directory: '../../../app/dist' } }) }), /"assets" is not the staged app build served asset-first by exact path/)
  await refused('a config with a single-page fallback', () => release('rel-1', { config: (c) => ({ ...c, assets: { ...c.assets, not_found_handling: 'single-page-application' } }) }), /"assets" is not the staged app build/)
  await refused('a config with the Worker first', () => release('rel-1', { config: (c) => ({ ...c, assets: { ...c.assets, run_worker_first: ['/*', '!/assets/*'] } }) }), /"assets" is not the staged app build/)
  await refused('a config without assets', () => release('rel-1', { config: ({ assets: _a, ...c }) => c }), /"assets" is not the staged app build/)
  await refused('a config with another document', () => release('rel-1', { config: (c) => ({ ...c, vars: { ...c.vars, VIZ_APP: c.vars.VIZ_APP.replace('<title>viz</title>', '<title>x</title>') } }) }), /VIZ_APP is not the staged build's/)
  await refused('a manifest configured with another build', () => release('rel-1', { entry: (e) => ({ ...e, app: { ...e.app, build: 'f'.repeat(64) } }) }), /the manifest was configured with app build f{12}, and the staged one is/)
})

test('release: a stage configured --without-app goes out without it, and its record says so', async () => {
  serves('viz-apptest-gateway')
  release('rel-1', { stage: 'apptest', app: 'without' })
  const out = await ship('apptest')
  assert.equal(out.result?.exit, 0, out.log + (out.error?.stack ?? ''))
  assert.deepEqual([out.result.record.app, out.result.record.withoutApp], [[{ worker: 'viz-apptest-gateway', withoutApp: true }], true])
  assert.match(out.log, /web app on viz-apptest-gateway: NONE \(a stage configured --without-app\)/)
  assert.equal(serving(readState(), 'viz-apptest-gateway').vars.VIZ_APP, undefined)
})

test('appProblems: a manifest without the app\'s Worker, or a plan without an app, has nothing to refuse', () => {
  release('rel-1')
  const m = JSON.parse(readFileSync(join(GENERATED_DIR, 'production', 'manifest.json'), 'utf8'))
  assert.deepEqual(appProblems(m, PLAN), [])
  assert.deepEqual(appProblems({ ...m, order: [], workers: [] }, PLAN), [])
  assert.deepEqual(appProblems(m, { workers: PLAN.workers.map(({ app: _a, ...w }) => w) }), [])
})

test('rollback: viz-gateway alone back to a version from before the app is allowed and said plainly; back to another build, said too; the record names what serves', async () => {
  serves()
  release('rel-1')
  const first = await ship()
  assert.equal(first.result?.exit, 0, first.log)
  const b = fixtureCopy()
  writeFileSync(join(b, 'assets', 'theme-Fx1TheMe.js'), 'document.documentElement.dataset.theme = "dark"\n')
  release('rel-2', { dist: b })
  const second = await ship()
  assert.equal(second.result?.exit, 0, second.log)
  const build1 = first.result.record.app[0].build
  const build2 = second.result.record.app[0].build
  assert.notEqual(build1, build2)
  assert.deepEqual(second.result.previous.app, [{ worker: GW, build: build1 }])

  // To the release before: the older build comes back with its version.
  const back1 = await captured(() => rollback({ stage: undefined, record: first.result.record, only: GW, reason: 'test' }))
  assert.equal(back1.result?.exit, 0, back1.log + (back1.error?.stack ?? ''))
  assert.match(back1.log, new RegExp(`viz-gateway goes back to web app build ${build1.slice(0, 12)} \\(it serves ${build2.slice(0, 12)} now\\)\\. A page opened under the newer build gets 404 for a chunk it has not loaded yet`))
  assert.deepEqual(back1.result.record.app, [{ worker: GW, build: build1 }])
  assert.equal(A.parseAppFiles(serving(readState(), GW).vars.VIZ_APP_FILES).build, build1)

  // To what served before the app (previous.json of the first release: fb77292's gateway): no app at all.
  const back0 = await captured(() => rollback({ stage: undefined, record: { ...first.result.previous, schemas: {}, formats: { [GW]: {} }, formatsComplete: true }, only: GW, reason: 'test' }))
  assert.equal(back0.result?.exit, 0, back0.log + (back0.error?.stack ?? ''))
  assert.match(back0.log, /NOTE: viz-gateway goes back to a version WITHOUT the web app \(it serves build [0-9a-f]{12} now\): every page and asset path answers 404 until a release with the app serves again; the API is not affected/)
  assert.deepEqual(back0.result.record.app, [{ worker: GW, build: null }])
  assert.equal(serving(readState(), GW).vars.VIZ_APP, undefined)
})

// ───────────────────────── a stage before production (review of D74, M-2) ─────────────────────────

/** A complete entry of deploy/records/app-stage-evidence.json for this checkout's serving code. */
const fingerprintNow = () => A.servingFingerprint({ repoRoot: REPO_ROOT, serve: SERVE, worker: A.appWorker(PLAN).worker }).fingerprint
const evidence = (over = {}) => ({
  serving: fingerprintNow(),
  stage: 'pretrial',
  release: 'a'.repeat(40),
  deployedAt: '2026-11-28T10:00:00.000Z',
  smoke: { passed: true, app: true, requests: 30 },
  byHand: Object.fromEntries(APP_STAGE_BY_HAND.map((n) => [n, { result: 'pass', note: `seen ${n}` }])),
  by: 'the owner',
  ...over,
})
const evidenceFile = (entries) => {
  const f = join(scratch('evidence'), 'app-stage-evidence.json')
  writeFileSync(f, typeof entries === 'string' ? entries : JSON.stringify({ v: 1, evidence: entries }))
  return f
}

test('M-2: what counts as a stage that went before: a complete entry for this release\'s serving code; the fingerprint follows the gateway\'s source, the asset rules and the headers, not the build', () => {
  assert.deepEqual(APP_STAGE_BY_HAND, ['6', '7', '8', '9', '10'])
  assert.deepEqual(evidenceGaps(evidence()), [])
  const gaps = (over) => evidenceGaps(evidence(over)).join('; ')
  assert.match(gaps({ smoke: { passed: false, app: true } }), /a smoke test that passed with the web app checked/)
  assert.match(gaps({ smoke: { passed: true, app: false } }), /a smoke test that passed with the web app checked/)
  assert.match(gaps({ by: ' ' }), /who vouches for it/)
  assert.match(gaps({ stage: 'Production!' }), /the stage's name/)
  assert.match(gaps({ deployedAt: 'yesterday' }), /when it was deployed/)
  for (const n of APP_STAGE_BY_HAND) {
    for (const item of [undefined, { result: null, note: '' }, { result: 'pass', note: ' ' }, { result: 'fail', note: 'the 304 lost its policy' }, { result: 'skipped', note: 'no time' }]) {
      assert.match(gaps({ byHand: { ...evidence().byHand, [n]: item } }), new RegExp(`by-hand check ${n} \\(result "pass" and a note of what was seen\\)`), `${n}: ${JSON.stringify(item)}`)
    }
  }
  assert.equal(evidenceGaps(null).length, 5 + APP_STAGE_BY_HAND.length)

  // The fingerprint: a toy tree with a gateway source of its own.
  const root = scratch('fp')
  const w = (p, text) => (mkdirSync(join(root, p, '..'), { recursive: true }), writeFileSync(join(root, p), text))
  w('deploy/gateway/src/index.ts', 'export default {}\n')
  w('deploy/gateway/src/api-roots.json', '{}')
  w('deploy/package-lock.json', JSON.stringify({ packages: { 'node_modules/wrangler': { version: '4.164.0' } } }))
  const worker = { name: 'viz-gateway', component: 'deploy/gateway' }
  const fp = (serve = SERVE) => A.servingFingerprint({ repoRoot: root, serve, worker })
  const base = fp()
  assert.match(base.fingerprint, /^[0-9a-f]{64}$/)
  assert.deepEqual(Object.keys(base.parts).sort(), ['assets', 'document', 'headers', 'worker', 'wrangler'])
  assert.equal(base.parts.wrangler, '4.164.0')
  assert.equal(fp().fingerprint, base.fingerprint)
  // What changes it: the Worker's source (any file of it), wrangler, the asset headers and types (`_headers`), the document's headers.
  const changed = (what, change, undo, serve) => {
    change()
    assert.notEqual(fp(serve).fingerprint, base.fingerprint, what)
    undo?.()
    assert.equal(fp().fingerprint, base.fingerprint, `${what}: undone`)
  }
  changed('the gateway\'s source', () => w('deploy/gateway/src/index.ts', 'export default { fetch() {} }\n'), () => w('deploy/gateway/src/index.ts', 'export default {}\n'))
  changed('the API\'s roots', () => w('deploy/gateway/src/api-roots.json', '{"exact":[]}'), () => w('deploy/gateway/src/api-roots.json', '{}'))
  changed('a new file of the Worker', () => w('deploy/gateway/src/extra.ts', 'export {}\n'), () => rmSync(join(root, 'deploy/gateway/src/extra.ts')))
  changed('wrangler\'s version', () => w('deploy/package-lock.json', JSON.stringify({ packages: { 'node_modules/wrangler': { version: '4.165.0' } } })), () => w('deploy/package-lock.json', JSON.stringify({ packages: { 'node_modules/wrangler': { version: '4.164.0' } } })))
  changed('an asset header', () => {}, null, A.readServe(serveWith((v) => (v.headers.asset['Cache-Control'] = 'public, max-age=600'))))
  changed('a content type', () => {}, null, A.readServe(serveWith((v) => (v.contentTypes['.svg'] = 'image/svg+xml; charset=utf-8'))))
  changed('the document\'s policy', () => {}, null, A.readServe(serveWith((v) => (v.headers.document['Content-Security-Policy'] += '; object-src \'none\''))))
  // What does not: another document path (data in a variable, served by the same code), a comment.
  assert.equal(fp(A.readServe(serveWith((v) => (v.documents.push('/another'), (v.comment = 'x'))))).fingerprint, base.fingerprint)
  // This checkout's own: it names the real gateway and the pinned wrangler.
  const real = A.servingFingerprint({ repoRoot: REPO_ROOT, serve: SERVE, worker: A.appWorker(PLAN).worker })
  assert.equal(real.parts.wrangler, readJson(join(DEPLOY_DIR, 'package-lock.json')).packages['node_modules/wrangler'].version)
})

test('M-2: the first production release with the web app is refused before anything is uploaded unless a stage is recorded to have gone before it, or the owner overrides with a reason; later releases and stages are not asked', async () => {
  const dir = join(GENERATED_DIR, 'production')
  const manifest = () => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  serves()
  release('rel-1')
  const live = { [GW]: { app: null } }
  const judge = (opts) => appStageProblems(manifest(), live, PLAN, opts)
  // No record at all (the repository as it is today has none).
  const none = judge({ evidenceFile: join(tmp, 'no-such-file.json') })
  assert.equal(none.first, true)
  assert.match(none.problems.join('\n'), /viz-gateway: this is the first production release that carries the web app \(the viz-gateway serving now has none\), and no stage is recorded to have gone before it: .*no-such-file\.json: it does not exist\. Deploy to a stage first/)
  assert.match(none.problems.join('\n'), /or the owner overrides with a reason \(VIZ_APP_WITHOUT_STAGE_EVIDENCE="…", the workflow's app_without_stage_evidence input\)/)
  assert.match(judge({ evidenceFile: evidenceFile([]) }).problems.join('\n'), /it has no entry/)
  // A stage of OTHER serving code (the gateway, the headers or wrangler changed since): no evidence for this release.
  assert.match(judge({ evidenceFile: evidenceFile([evidence({ serving: 'f'.repeat(64) })]) }).problems.join('\n'), /it has 1 entry, none for this release's serving code \(fingerprint [0-9a-f]{12}: the gateway's source, the asset configuration, `_headers`, the document's headers or wrangler changed since\)/)
  // An entry as the script writes it, the by-hand checks not made yet; a failed one; a stage whose smoke test skipped the app.
  const unmade = Object.fromEntries(APP_STAGE_BY_HAND.map((n) => [n, { what: 'x', result: null, note: '' }]))
  assert.match(judge({ evidenceFile: evidenceFile([evidence({ byHand: unmade })]) }).problems.join('\n'), /its entry for this serving code \(stage "pretrial"\) lacks: by-hand check 6 .*; by-hand check 10 /)
  assert.match(judge({ evidenceFile: evidenceFile([evidence({ byHand: { ...evidence().byHand, 9: { result: 'fail', note: 'a page for /assets/..%2f' } } })]) }).problems.join('\n'), /lacks: by-hand check 9 /)
  assert.match(judge({ evidenceFile: evidenceFile([evidence({ smoke: { passed: true, app: false } })]) }).problems.join('\n'), /lacks: a smoke test that passed with the web app checked/)
  assert.match(judge({ evidenceFile: evidenceFile('{ not json') }).problems.join('\n'), /cannot be read/)
  assert.match(judge({ evidenceFile: evidenceFile('{"v":2}') }).problems.join('\n'), /cannot be read \(not \{ "v": 1, "evidence": \[\.\.\.\] \}\)/)
  // Complete, for this code: allowed, and the record names the stage and who vouched.
  const good = judge({ evidenceFile: evidenceFile([evidence({ serving: 'f'.repeat(64) }), evidence()]) })
  assert.deepEqual([good.problems, good.record], [[], { first: true, fingerprint: fingerprintNow(), evidence: { stage: 'pretrial', release: 'a'.repeat(40), deployedAt: '2026-11-28T10:00:00.000Z', by: 'the owner' } }])
  assert.match(good.notes.join('\n'), /stage "pretrial" went before it .*vouched for by the owner/)
  // The override: allowed, loudly; a blank one is none.
  const over = judge({ evidenceFile: join(tmp, 'no-such-file.json'), override: 'the owner accepts the first contact in production' })
  assert.deepEqual([over.problems, over.record], [[], { first: true, fingerprint: fingerprintNow(), override: 'the owner accepts the first contact in production' }])
  assert.match(over.notes.join('\n'), /WARNING: first production release with the web app WITHOUT a stage before it, by override \(VIZ_APP_WITHOUT_STAGE_EVIDENCE\): "the owner accepts/)
  assert.equal(judge({ evidenceFile: join(tmp, 'no-such-file.json'), override: '   ' }).problems.length, 1)
  // Not the first: the gateway serving now has an app. Not production: a stage. Not this rule's: a manifest without a build.
  for (const r of [appStageProblems(manifest(), { [GW]: { app: 'b'.repeat(64) } }, PLAN, { evidenceFile: join(tmp, 'no-such-file.json') }), appStageProblems({ ...manifest(), stage: 'apptest' }, live, PLAN, {}), appStageProblems({ ...manifest(), workers: manifest().workers.map((w) => ({ ...w, app: { notBuilt: true } })) }, live, PLAN, {})]) assert.deepEqual([r.first, r.problems, r.record], [false, [], null])
  // A Worker that does not exist yet, or serves two versions, has no app serving either: first.
  assert.equal(appStageProblems(manifest(), {}, PLAN, { evidenceFile: join(tmp, 'no-such-file.json') }).problems.length, 1)

  // Through release.mjs itself: plan and deploy refuse (exit 3), nothing is uploaded.
  const before = readState().calls.length
  for (const run of [() => planOnly({ stage: undefined, appStageEvidence: join(tmp, 'no-such-file.json') }), () => deploy({ stage: undefined, appStageEvidence: join(tmp, 'no-such-file.json') })]) {
    const out = await captured(run)
    assert.equal(out.result?.exit, 3, out.log + (out.error?.stack ?? ''))
    assert.match(out.log, /this is the first production release that carries the web app/)
  }
  assert.deepEqual(readState().calls.slice(before).map(cmd), [], 'nothing uploaded')
  // With the committed record as it is in this repository (none: no stage has been deployed), the default refuses too.
  const asIs = await captured(() => planOnly({ stage: undefined }))
  assert.equal(asIs.result?.exit, existsSync(join(DEPLOY_DIR, 'records', 'app-stage-evidence.json')) ? asIs.result?.exit : 3, asIs.log)
  // With the evidence: it goes out, and the release record says which stage went before it.
  const withEvidence = await captured(() => deploy({ stage: undefined, appStageEvidence: evidenceFile([evidence()]) }))
  assert.equal(withEvidence.result?.exit, 0, withEvidence.log + (withEvidence.error?.stack ?? ''))
  assert.deepEqual(withEvidence.result.record.appStage.evidence, { stage: 'pretrial', release: 'a'.repeat(40), deployedAt: '2026-11-28T10:00:00.000Z', by: 'the owner' })
  assert.match(withEvidence.log, /first production release with the web app: stage "pretrial" went before it/)
  assert.match(withEvidence.log, /First production release with the web app; stage `pretrial` went before it/)
  // The next release: the app serves, nothing is asked, and the record says nothing of a stage.
  release('rel-2')
  const next = await captured(() => deploy({ stage: undefined, appStageEvidence: join(tmp, 'no-such-file.json') }))
  assert.equal(next.result?.exit, 0, next.log + (next.error?.stack ?? ''))
  assert.equal(next.result.record.appStage, null)

  // By override instead: it goes out, and both the log and the record carry the reason.
  serves()
  release('rel-3')
  const overridden = await captured(() => deploy({ stage: undefined, appStageEvidence: join(tmp, 'no-such-file.json'), appStageOverride: 'owner: accepted, 2026-11-28' }))
  assert.equal(overridden.result?.exit, 0, overridden.log + (overridden.error?.stack ?? ''))
  assert.deepEqual(overridden.result.record.appStage, { first: true, fingerprint: fingerprintNow(), override: 'owner: accepted, 2026-11-28' })
  assert.match(overridden.log, /WARNING: first production release with the web app WITHOUT a stage before it, by override/)
  assert.match(overridden.log, /\*\*First production release with the web app, without a stage before it\*\*, by override: "owner: accepted, 2026-11-28"/)
  // A stage is never asked.
  serves('viz-apptest-gateway')
  release('rel-1', { stage: 'apptest' })
  const stage = await captured(() => deploy({ stage: 'apptest', appStageEvidence: join(tmp, 'no-such-file.json') }))
  assert.equal(stage.result?.exit, 0, stage.log + (stage.error?.stack ?? ''))
  assert.equal(stage.result.record.appStage, null)
})

test('M-2: the entry of a stage is written from what its deploy left behind, with the by-hand checks empty: it does not count until a person has made them', () => {
  const gen = scratch('gen')
  const dir = join(gen, 'stage-pretrial')
  mkdirSync(dir, { recursive: true })
  const put = (release, smoke) => {
    writeFileSync(join(dir, 'release.json'), JSON.stringify(release))
    writeFileSync(join(dir, 'smoke.json'), JSON.stringify(smoke))
  }
  const rel = { release: 'c'.repeat(40), recordedAt: '2026-11-28T09:00:00.000Z', withoutApp: false, app: [{ worker: 'viz-pretrial-gateway', build: 'b'.repeat(64), serving: fingerprintNow() }] }
  const smoke = { ok: true, release: 'c'.repeat(40), web: { ok: true, checked: 31 }, data: 'skipped', at: '2026-11-28T09:05:00.000Z' }
  put(rel, smoke)
  const entry = evidenceEntry({ stage: 'pretrial', by: ' the owner ', generatedDir: gen, now: new Date('2026-11-28T10:00:00Z') })
  assert.deepEqual([entry.serving, entry.stage, entry.release, entry.deployedAt, entry.build, entry.by], [fingerprintNow(), 'pretrial', 'c'.repeat(40), '2026-11-28T09:00:00.000Z', 'b'.repeat(64), 'the owner'])
  assert.deepEqual(entry.smoke, { passed: true, app: true, requests: 31, data: 'skipped', at: '2026-11-28T09:05:00.000Z' })
  // As written it is incomplete, by exactly the five checks a person makes.
  assert.deepEqual(evidenceGaps(entry), APP_STAGE_BY_HAND.map((n) => `by-hand check ${n} (result "pass" and a note of what was seen)`))
  for (const n of APP_STAGE_BY_HAND) entry.byHand[n] = { ...entry.byHand[n], result: 'pass', note: 'seen' }
  assert.deepEqual(evidenceGaps(entry), [])
  // What is no evidence: a stage without the app, a smoke test that failed or skipped the app or is of another release, serving code that changed since, no name to vouch.
  const refused = [
    [{ ...rel, withoutApp: true, app: [{ worker: 'x', withoutApp: true }] }, smoke, /went without the web app/],
    [rel, { ...smoke, ok: false }, /did not pass with the web app checked/],
    [rel, { ...smoke, web: 'skipped' }, /did not pass with the web app checked/],
    [rel, { ...smoke, web: { ok: false, checked: 3 } }, /did not pass with the web app checked/],
    [rel, { ...smoke, release: 'd'.repeat(40) }, /is of release d{40}, not c{40}/],
    [{ ...rel, app: [{ ...rel.app[0], serving: 'e'.repeat(64) }] }, smoke, /the serving code changed since stage pretrial was deployed/],
  ]
  for (const [r, s, why] of refused) {
    put(r, s)
    assert.throws(() => evidenceEntry({ stage: 'pretrial', by: 'x', generatedDir: gen }), why)
  }
  put(rel, smoke)
  assert.throws(() => evidenceEntry({ stage: 'pretrial', by: '', generatedDir: gen }), /--by "<name>" is needed/)
  assert.throws(() => evidenceEntry({ stage: undefined, by: 'x', generatedDir: gen }), /--stage <name> is needed/)
  assert.throws(() => evidenceEntry({ stage: 'other', by: 'x', generatedDir: gen }), /release\.json is missing: run deploy\/deploy\.sh --stage other first/)
})
