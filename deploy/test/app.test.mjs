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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { after, beforeEach, test } from 'node:test'

// Before the deploy modules load: generated/ is this test's own.
const tmp = mkdtempSync(join(tmpdir(), 'viz-app-test-'))
process.env.VIZ_GENERATED_DIR = join(tmp, 'generated')
const A = await import('../lib/app.mjs')
const { DEPLOY_DIR, GENERATED_DIR, REPO_ROOT, readJson, readJsonc } = await import('../lib/common.mjs')
const { APP_FIXTURE, WITHOUT_APP, appBuilt, callsLike, captured, cmd, installFakeAccount, serving } = await import('./fake-account.mjs')
const { build } = await import('../app.mjs')
const { configure, generateWorker } = await import('../configure.mjs')
const { appProblems, deploy, planOnly, rollback } = await import('../release.mjs')

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
  assert.deepEqual([found.app.dir, found.app.serve, found.app.needs], ['app', 'app/serve.json', ['design-system']])
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
  assert.equal(v.etag, `"${b.documentSha256.slice(0, 32)}"`)
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
  for (const bad of [undefined, '', 'x', '{}', '{"v":2,"build":"x"}']) assert.equal(A.parseAppFiles(bad), null)
})

test('which files a new build keeps: those the serving build had and it has not, for keep_builds builds; nothing but hashed assets of a known type', () => {
  const serving = { build: H('1'), files: new Map([['/assets/index-AAAAAAAA.js', H('a')], ['/assets/Editor-BBBBBBBB.js', H('b')], ['/assets/Sans-CCCCCCCC.woff2', H('c')], ['/favicon.svg', H('f')]]), kept: [{ path: '/assets/index-OLD00001.js', sha256: H('d'), age: 1 }, { path: '/assets/index-OLD00003.js', sha256: H('e'), age: 3 }] }
  const next = buildOf(H('2'), { '/assets/index-NEWNEWNE.js': H('9'), '/assets/Sans-CCCCCCCC.woff2': H('c'), '/favicon.svg': H('f') })
  assert.deepEqual(A.carryPlan(serving, next, SERVE, 3), [
    { path: '/assets/Editor-BBBBBBBB.js', sha256: H('b'), age: 1 },
    { path: '/assets/index-AAAAAAAA.js', sha256: H('a'), age: 1 },
    { path: '/assets/index-OLD00001.js', sha256: H('d'), age: 2 },
  ])
  assert.deepEqual(A.carryPlan(serving, next, SERVE, 1).map((f) => f.path), ['/assets/Editor-BBBBBBBB.js', '/assets/index-AAAAAAAA.js'])
  assert.deepEqual(A.carryPlan(serving, next, SERVE, 0), [])
  assert.deepEqual(A.carryPlan(null, next, SERVE, 3), [])
  // The same build again (a release that did not change the app): what was kept stays as old as it was.
  const same = buildOf(H('1'), Object.fromEntries(serving.files))
  assert.deepEqual(A.carryPlan(serving, same, SERVE, 3), [{ path: '/assets/index-OLD00001.js', sha256: H('d'), age: 1 }, { path: '/assets/index-OLD00003.js', sha256: H('e'), age: 3 }])
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
  w('app/build.mjs', "import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs'\nif (!existsSync('../design-system/tokens.json')) throw new Error('no design system')\nif (existsSync('reviews') || existsSync('../design-system/dist/stale.css') || existsSync('local.env')) throw new Error('the export holds what a build is not made from')\nreadFileSync('src/main.ts')\nrmSync('dist', { recursive: true, force: true })\ncpSync('prepared', 'dist', { recursive: true })\n")
  w('app/reviews/shot.png', 'not a source')
  w('app/local.env', 'IGNORED=1\n')
  w('app/.gitignore', 'dist/\nnode_modules/\nlocal.env\n')
  w('design-system/tokens.json', '{}')
  w('design-system/dist/stale.css', 'generated, ignored')
  w('design-system/.gitignore', 'dist/\n')
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

test('app.mjs build: exports the sources, builds there (never in the checkout), stages and stamps; a failed build stages nothing', async () => {
  const t = toyRepo()
  const r = await captured(() => build({ stage: 'apptest', release: 'toy-1', carry: false, plan: t.plan, repoRoot: t.root }))
  assert.equal(r.error, undefined, `${r.error?.stack}\n${r.log}`)
  const stamp = r.result
  assert.equal(existsSync(join(t.root, 'app', 'dist')), false, 'nothing was built in the checkout')
  assert.equal(existsSync(join(GENERATED_DIR, 'stage-apptest', 'app-build', 'app', 'dist', 'index.html')), true)
  assert.equal(existsSync(join(GENERATED_DIR, 'stage-apptest', 'app-build', 'app', 'local.env')), false, 'an ignored file is not exported')
  assert.deepEqual([stamp.release, stamp.target, stamp.via, stamp.sources.commit, stamp.sources.dirty], ['toy-1', 'stage-apptest', 'export', t.head, false])
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
  t.w('app/serve.json', JSON.stringify({ ...RAW, documents: [...RAW.documents, '/dashboards'] }))
  assert.match(judge().join('\n'), /app\/serve\.json changed after the app was built/)
  t.g('checkout', '-q', '--', 'app/serve.json')
  assert.deepEqual(judge(), [])
  // A build handed in is not production's; a stage may take one, and its stamp says so.
  writeFileSync(stampFile, JSON.stringify({ ...JSON.parse(original), via: 'prebuilt' }))
  assert.match(judge().join('\n'), /was not made by deploy\/app\.mjs from this checkout's sources \(it is "prebuilt"\)/)
  restore()
  writeFileSync(stampFile, JSON.stringify({ ...JSON.parse(original), v: 99 }))
  assert.match(judge().join('\n'), /not an app stamp of version 1/)
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
})

// ───────────────────────── configure.mjs ─────────────────────────

const STAGE = 'apptest'
const RESOURCES = { kv_namespaces: { [`viz-${STAGE}-config`]: 'c'.repeat(32), 'viz-config': 'd'.repeat(32) }, ratelimit_namespaces: {} }
const conf = (opts = {}) => configure({ stage: STAGE, release: 'r1', quiet: true, resources: RESOURCES, oauthWithoutRateLimits: true, ...opts })
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
const ship = (stage) => captured(() => deploy({ stage }))
const uploads = () => readState().calls.filter((c) => c.argv[0] === 'versions' || c.argv[0] === 'deploy' || c.argv[0] === 'triggers')

test('release: production goes out with the staged build; the uploaded version carries the document and the file list, and the record names the build', async () => {
  serves()
  const r = release('rel-1')
  const plan = await captured(() => planOnly({ stage: undefined }))
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
})

test('release: a missing, stale or altered build is refused (exit 3) before anything is uploaded', async () => {
  const refused = async (what, prepare, why, stage) => {
    serves(stage ? `viz-${stage}-gateway` : GW)
    prepare()
    const before = readState().calls.length
    for (const run of [() => planOnly({ stage }), () => deploy({ stage })]) {
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
