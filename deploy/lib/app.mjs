// The web app's build, as viz-gateway serves it (design/DECISIONS.md D74; deploy/README.md, "The web app").
//
// app/serve.json is the specification: which paths are documents, which prefix holds the hashed
// assets, which files exist besides, and which headers and content types each carries. Everything
// here is derived from it, and anything in it this code does not know is refused, so that a later
// change to serve.json fails here (and in the tests that read it) instead of drifting.
//
// How the gateway serves by it:
// - hashed assets and the listed files are Workers Static Assets of viz-gateway, served by
//   Cloudflare without invoking the Worker (asset-first routing, html_handling and
//   not_found_handling "none"); their headers come from the `_headers` file generated here;
// - the documents are served by the Worker, from the VIZ_APP var generated here (the document and
//   its headers), so index.html is never an asset: nothing in the asset directory is anything but a
//   public file;
// - every other path reaches the Worker, which answers as it always did.
//
// A build is made in an export of the sources (never in app/ itself), staged into the directory
// wrangler uploads, and described by a stamp (app.json) that configure.mjs reads and release.mjs
// verifies before anything is uploaded: a missing, stale or altered build is refused.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

/** The var the Worker serves documents from: `{ v, build, etag, documents, headers, document }`. */
export const APP_VAR = 'VIZ_APP'
/** The var that names every asset file of a version, for the next release and for records: `{ v, build, files, kept }`. Not read by the Worker. */
export const APP_FILES_VAR = 'VIZ_APP_FILES'
/** Cloudflare's limit is 5 KB per variable (Workers limits, read 2026-11-26); these stay under it with a margin. */
export const VAR_MAX_BYTES = 4500
/** Workers Static Assets limits (read 2026-11-26): 25 MiB per file, 100 `_headers` rules, 2,000 characters per line. */
export const ASSET_MAX_BYTES = 25 * 1024 * 1024
export const HEADERS_MAX_RULES = 100
export const HEADERS_MAX_LINE = 2000
/** How many earlier builds' hashed files a version keeps serving for pages opened before a deploy. */
export const KEEP_BUILDS_DEFAULT = 3
export const STAMP_VERSION = 1

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/ // an HTTP header name
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/ // a path segment a build may emit: no dot files, nothing to decode
const SERVE_KEYS = new Set(['comment', 'documents', 'assetsPrefix', 'files', 'headers', 'contentTypes'])
const HEADER_KINDS = ['document', 'asset', 'file']

const bytes = (s) => Buffer.byteLength(s, 'utf8')

/**
 * app/serve.json, checked. Refuses anything this code does not serve by: an unknown key (a new rule
 * the gateway would silently not follow), a document or file path that is not a plain path, a
 * header that is not one line, a content type per extension that is missing.
 */
export function readServe(file) {
  const where = file
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`${where} not found: it says how the app's build is served, and viz-gateway serves by it`)
  }
  const spec = JSON.parse(raw)
  const fail = (msg) => {
    throw new Error(`${where}: ${msg}`)
  }
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) fail('an object')
  for (const k of Object.keys(spec)) if (!SERVE_KEYS.has(k)) fail(`"${k}" is a rule deploy/lib/app.mjs does not know how to serve by; extend it (and the gateway) rather than drop it`)
  const paths = (list, what) => {
    if (!Array.isArray(list) || list.length === 0 || new Set(list).size !== list.length) fail(`"${what}" must be a non-empty list of distinct paths`)
    for (const p of list) if (typeof p !== 'string' || !(p === '/' || (p.startsWith('/') && p.slice(1).split('/').every((s) => SEGMENT.test(s))))) fail(`"${what}": ${JSON.stringify(p)} is not a plain path (segments of letters, digits, ".", "_" and "-", no trailing slash)`)
    return [...list]
  }
  const documents = paths(spec.documents, 'documents')
  const files = spec.files === undefined || (Array.isArray(spec.files) && spec.files.length === 0) ? [] : paths(spec.files, 'files')
  if (typeof spec.assetsPrefix !== 'string' || !/^\/[A-Za-z0-9_][A-Za-z0-9._-]*\/$/.test(spec.assetsPrefix)) fail(`"assetsPrefix" must be one directory, like "/assets/", not ${JSON.stringify(spec.assetsPrefix)}`)
  const assetsPrefix = spec.assetsPrefix
  for (const p of [...documents, ...files]) if (p.startsWith(assetsPrefix) || `${p}/` === assetsPrefix) fail(`${p} is under the asset prefix ${assetsPrefix}`)
  for (const f of files) if (documents.includes(f) || f === '/') fail(`${f} is both a document and a file`)
  if (typeof spec.contentTypes !== 'object' || spec.contentTypes === null) fail('"contentTypes" must map an extension to a content type')
  const contentTypes = {}
  for (const [ext, type] of Object.entries(spec.contentTypes)) {
    if (!/^\.[a-z0-9]+$/.test(ext)) fail(`contentTypes: ${JSON.stringify(ext)} is not an extension like ".js"`)
    if (typeof type !== 'string' || !/^[a-z]+\/[A-Za-z0-9.+-]+(; charset=utf-8)?$/.test(type)) fail(`contentTypes ${ext}: ${JSON.stringify(type)} is not a content type`)
    contentTypes[ext] = type
  }
  for (const f of files) if (!contentTypes[extname(f)]) fail(`files: ${f} has no content type under "contentTypes"`)
  if (typeof spec.headers !== 'object' || spec.headers === null) fail('"headers" must be { document, asset, file }')
  for (const k of Object.keys(spec.headers)) if (!HEADER_KINDS.includes(k)) fail(`headers.${k}: only ${HEADER_KINDS.join(', ')} are served`)
  const headers = {}
  for (const kind of HEADER_KINDS) {
    const h = spec.headers[kind]
    if (typeof h !== 'object' || h === null || Array.isArray(h)) fail(`headers.${kind} must be an object of header names and values`)
    const seen = new Set()
    for (const [name, value] of Object.entries(h)) {
      if (!TOKEN.test(name)) fail(`headers.${kind}: ${JSON.stringify(name)} is not a header name`)
      if (seen.has(name.toLowerCase())) fail(`headers.${kind}: ${name} twice`)
      seen.add(name.toLowerCase())
      // One line of visible ASCII: a `_headers` line, and a header value, hold nothing else.
      if (typeof value !== 'string' || value === '' || !/^[\x20-\x7e]+$/.test(value) || value !== value.trim()) fail(`headers.${kind}.${name}: the value must be one line of printable ASCII`)
    }
    headers[kind] = { ...h }
  }
  const lower = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))
  const doc = lower(headers.document)
  // What a document must carry whatever else changes: its type, revalidation on every load, and the policy.
  if (!/^text\/html; charset=utf-8$/.test(doc['content-type'] ?? '')) fail('headers.document must say Content-Type: text/html; charset=utf-8')
  if (!doc['content-security-policy']) fail('headers.document must carry a Content-Security-Policy')
  if (!/\bno-cache\b|\bno-store\b/.test(doc['cache-control'] ?? '') || /immutable|max-age=[1-9]/.test(doc['cache-control'])) fail('headers.document must be revalidated on every load (Cache-Control: no-cache): the document names the hashed assets of one build')
  for (const kind of ['asset', 'file']) {
    const h = lower(headers[kind])
    if (!h['cache-control']) fail(`headers.${kind} must carry a Cache-Control`)
    if ('content-type' in h) fail(`headers.${kind}: the content type comes from "contentTypes", by extension`)
  }
  return { documents, assetsPrefix, files, headers, contentTypes, sha256: sha256(raw) }
}

/** The app block of deploy/workers.json for a Worker, checked: `{ dir, serve, needs, notBuiltFrom, keepBuilds }`. */
export function appBlock(worker) {
  const a = worker.app
  if (a === undefined) return null
  const where = `deploy/workers.json ${worker.name}.app`
  const rel = (p, what) => {
    if (typeof p !== 'string' || p === '' || p.startsWith('/') || p.split('/').some((s) => s === '..' || s === '.' || s === '')) throw new Error(`${where}: ${what} must be a path inside the repository, not ${JSON.stringify(p)}`)
    return p
  }
  const list = (v, what) => {
    if (v === undefined) return []
    if (!Array.isArray(v)) throw new Error(`${where}: ${what} must be a list`)
    return v.map((p) => rel(p, what))
  }
  const keep = a.keep_builds ?? KEEP_BUILDS_DEFAULT
  if (!Number.isInteger(keep) || keep < 0 || keep > 20) throw new Error(`${where}: keep_builds must be an integer from 0 to 20`)
  return { dir: rel(a.dir, '"dir"'), serve: rel(a.serve, '"serve"'), needs: list(a.needs, '"needs"'), notBuiltFrom: list(a.not_built_from, '"not_built_from"'), keepBuilds: keep }
}

/** The Worker of a plan that serves the app (at most one), with its checked block; null when none does. */
export function appWorker(plan) {
  const with_ = plan.workers.filter((w) => w.app !== undefined)
  if (with_.length > 1) throw new Error(`deploy/workers.json: ${with_.map((w) => w.name).join(', ')} each declare "app"; one Worker serves it`)
  return with_.length ? { worker: with_[0], app: appBlock(with_[0]) } : null
}

// ---- sources ----

const WALK_SKIP = new Set(['node_modules', 'dist', 'dist-new', '.wrangler', '.git', '.vite'])

function walk(root, dir, out) {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (WALK_SKIP.has(e.name)) continue
    const p = `${dir}/${e.name}`
    if (e.isDirectory()) walk(root, p, out)
    else if (e.isFile()) out.push(p)
  }
}

function git(root, args) {
  // The repository's own configuration only: an inherited GIT_DIR (a hook, a test) must not move it.
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k]
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env })
  return r.status === 0 ? r.stdout : null
}

/**
 * The files a build is made from: everything under the app's directory and the directories it
 * needs, except what workers.json says it is not built from (review images, measurements). In a git
 * work tree: tracked files and untracked ones git does not ignore, so that a generated, ignored file
 * lying in a checkout can never reach a build; elsewhere: every file but dependency and build
 * output directories. Returns `{ files: [repo-relative paths], commit, dirty, by }`.
 */
export function listSources(root, app) {
  const dirs = [app.dir, ...app.needs]
  for (const d of dirs) if (!existsSync(join(root, d))) throw new Error(`${d}/ is not in this checkout, and the app is built from it`)
  const excluded = (p) => app.notBuiltFrom.some((x) => p === x || p.startsWith(`${x}/`))
  const top = git(root, ['rev-parse', '--show-toplevel'])
  // Only when `root` is the work tree itself: a copy of the tree inside some other repository is not one.
  if (top !== null && resolve(top.trim()) === resolve(root)) {
    const listed = git(root, ['ls-files', '-co', '--exclude-standard', '-z', '--', ...dirs])
    if (listed === null) throw new Error('git ls-files failed')
    // A tracked file deleted in the work tree is still listed; it is not there to build from.
    const files = listed.split('\0').filter((p) => p && !excluded(p) && existsSync(join(root, p)) && lstatSync(join(root, p)).isFile()).sort()
    const status = git(root, ['status', '--porcelain', '-z', '--', ...dirs]) ?? ''
    const dirty = status.split('\0').filter(Boolean).map((l) => l.slice(3)).filter((p) => !excluded(p))
    return { files, commit: (git(root, ['rev-parse', 'HEAD']) ?? '').trim() || null, dirty: dirty.length > 0, dirtyFiles: dirty.slice(0, 20), by: 'git' }
  }
  const files = []
  for (const d of dirs) walk(root, d, files)
  return { files: files.filter((p) => !excluded(p)).sort(), commit: null, dirty: null, dirtyFiles: [], by: 'walk' }
}

/** One hash over the paths and contents of the sources. */
export function hashSources(root, files) {
  const h = createHash('sha256')
  for (const p of files) h.update(`${p}\0${sha256(readFileSync(join(root, p)))}\n`)
  return h.digest('hex')
}

// ---- the build, staged ----

/** Every file under `dir`, as `/`-separated relative paths. */
function filesUnder(dir, rel = '') {
  const out = []
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...filesUnder(dir, p))
    else out.push(p)
  }
  return out.sort()
}

/**
 * Reads a build (`dist`) by serve.json's rules and refuses whatever they do not cover: the build is
 * index.html, files under the asset prefix (each with a known content type and a plain name) and
 * the listed files; nothing else, and nothing missing.
 * Returns `{ document, files: [{ path, bytes, sha256 }], hash }`, `path` as it is requested.
 */
export function readBuild(dist, serve) {
  if (!existsSync(join(dist, 'index.html'))) throw new Error(`${dist}: no index.html: the app's build is missing (run deploy/app.mjs build)`)
  const prefixDir = serve.assetsPrefix.slice(1) // "assets/"
  const files = []
  let document = null
  for (const rel of filesUnder(dist)) {
    const abs = join(dist, rel)
    const st = lstatSync(abs)
    if (!st.isFile()) throw new Error(`${dist}/${rel}: not a regular file (a link is never uploaded)`)
    if (rel === 'index.html') {
      document = readFileSync(abs, 'utf8')
      continue
    }
    const path = `/${rel}`
    const isAsset = rel.startsWith(prefixDir)
    if (!isAsset && !serve.files.includes(path)) throw new Error(`${dist}/${rel}: the build has a file app/serve.json does not say how to serve (not index.html, not under ${serve.assetsPrefix}, not one of ${serve.files.join(', ') || 'its files'})`)
    if (!rel.split('/').every((s) => SEGMENT.test(s))) throw new Error(`${dist}/${rel}: not a plain file name`)
    if (!serve.contentTypes[extname(rel)]) throw new Error(`${dist}/${rel}: app/serve.json names no content type for ${extname(rel) || 'a file without an extension'}`)
    if (st.size > ASSET_MAX_BYTES) throw new Error(`${dist}/${rel}: ${st.size} bytes; a static asset is at most ${ASSET_MAX_BYTES} (25 MiB)`)
    files.push({ path, bytes: st.size, sha256: sha256(readFileSync(abs)) })
  }
  for (const f of serve.files) if (!files.some((x) => x.path === f)) throw new Error(`${dist}: ${f} is listed in app/serve.json but not in the build`)
  if (!files.some((f) => f.path.startsWith(serve.assetsPrefix))) throw new Error(`${dist}: nothing under ${serve.assetsPrefix}: not a build of the app`)
  // The document asks only for what the build holds, from this origin: a stale or foreign index.html fails here.
  const refs = [...document.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1])
  for (const r of refs) if (!files.some((f) => f.path === r)) throw new Error(`${dist}/index.html asks for ${r}, which the build does not hold (a build mixed from two, or a reference to another origin)`)
  if (!refs.some((r) => r.startsWith(serve.assetsPrefix))) throw new Error(`${dist}/index.html asks for nothing under ${serve.assetsPrefix}: not a build of the app`)
  if (/<script(?![^>]*\bsrc=)[^>]*>/.test(document)) throw new Error(`${dist}/index.html has an inline script, which the document's content security policy refuses`)
  const hash = createHash('sha256').update(`index.html\0${sha256(document)}\n`)
  for (const f of files) hash.update(`${f.path}\0${f.sha256}\n`)
  return { document, documentSha256: sha256(document), files, hash: hash.digest('hex') }
}

/**
 * The `_headers` file of the asset directory (Workers Static Assets, "Custom headers", read
 * 2026-11-26): the headers of serve.json for what Cloudflare serves without the Worker. One rule
 * for everything under the asset prefix, one per content type (the type is set, not left to the
 * uploader's guess), one per listed file. Each header appears once per path: a header set twice is
 * joined with a comma there.
 */
export function headersFile(serve) {
  const rules = []
  const block = (pattern, headers) => rules.push([pattern, ...Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`)].join('\n'))
  block(`${serve.assetsPrefix}*`, serve.headers.asset)
  for (const [ext, type] of Object.entries(serve.contentTypes)) block(`${serve.assetsPrefix}*${ext}`, { 'Content-Type': type })
  for (const f of serve.files) block(f, { ...serve.headers.file, 'Content-Type': serve.contentTypes[extname(f)] })
  if (rules.length > HEADERS_MAX_RULES) throw new Error(`_headers would have ${rules.length} rules; Cloudflare allows ${HEADERS_MAX_RULES}`)
  const text = `# GENERATED by deploy/lib/app.mjs from app/serve.json. Do not edit.\n${rules.join('\n\n')}\n`
  for (const line of text.split('\n')) if (line.length > HEADERS_MAX_LINE) throw new Error(`_headers: a line of ${line.length} characters; Cloudflare allows ${HEADERS_MAX_LINE}`)
  return text
}

/** What the generated wrangler config says of the asset directory (`directory` relative to the config). */
export function assetsConfig(directory) {
  // Asset-first, exact paths only: a path that is a file of the build is served by Cloudflare, every
  // other path invokes the Worker. No HTML handling (no redirects, no index.html) and no fallback
  // page: the Worker decides what a path that is no file gets.
  return { directory, html_handling: 'none', not_found_handling: 'none', run_worker_first: false }
}

/** The quoted entity tag of a document: its hash. A page compares it to learn that a newer build serves. */
export const documentEtag = (documentSha256) => `"${documentSha256.slice(0, 32)}"`

/** The VIZ_APP var: what the Worker serves the documents from. */
export function appVar(serve, build) {
  const text = JSON.stringify({ v: 1, build: build.hash, etag: documentEtag(build.documentSha256), documents: serve.documents, headers: serve.headers.document, document: build.document })
  if (bytes(text) > VAR_MAX_BYTES) throw new Error(`${APP_VAR} would be ${bytes(text)} bytes (the document is ${bytes(build.document)}); a Worker variable holds 5 KB. The document has outgrown a variable: serve it another way (design/DECISIONS.md D74, "would change if")`)
  return text
}

const digest = (hex) => Buffer.from(hex, 'hex').toString('base64url')
const undigest = (b64) => Buffer.from(b64, 'base64url').toString('hex')

/**
 * The VIZ_APP_FILES var: the build, each of its files with its SHA-256, and the files kept from
 * earlier builds with how many builds ago each was last current. When it would not fit a variable,
 * the oldest kept files are left out of it (and of the directory, by the caller); when the build's
 * own files do not fit, it names none (`files: null`), and the next release can keep nothing.
 * Returns `{ text, kept }` with the kept files that fit.
 */
export function appFilesVar(build, kept) {
  const make = (k, withFiles = true) =>
    JSON.stringify({ v: 1, build: build.hash, files: withFiles ? Object.fromEntries(build.files.map((f) => [f.path, digest(f.sha256)])) : null, kept: Object.fromEntries(k.map((f) => [f.path, [digest(f.sha256), f.age]])) })
  let list = [...kept].sort((a, b) => a.age - b.age || a.path.localeCompare(b.path))
  while (list.length > 0 && bytes(make(list)) > VAR_MAX_BYTES) list = list.slice(0, -1)
  if (bytes(make(list)) > VAR_MAX_BYTES) return { text: make([], false), kept: [] }
  return { text: make(list), kept: list }
}

/** A version's VIZ_APP_FILES, parsed: `{ build, files: Map(path → sha256 hex) | null, kept: [{ path, sha256, age }] }`, or null. */
export function parseAppFiles(text) {
  if (typeof text !== 'string' || text === '') return null
  try {
    const v = JSON.parse(text)
    if (v?.v !== 1 || typeof v.build !== 'string') return null
    const files = v.files === null ? null : new Map(Object.entries(v.files).map(([p, d]) => [p, undigest(d)]))
    const kept = Object.entries(v.kept ?? {}).map(([path, [d, age]]) => ({ path, sha256: undigest(d), age }))
    return { build: v.build, files, kept }
  } catch {
    return null
  }
}

/**
 * Which files of the version serving now a new build keeps (Cloudflare, "Version skew and static
 * assets", read 2026-11-26: "Include assets needed by older pages": a page opened before a deploy
 * asks the new version for the old build's files, and a version serves only its own). A file that
 * was current in the serving build and is not in the new one is kept at age 1; a file the serving
 * version itself kept ages by one when the build changed, and is dropped past `keepBuilds`. Pure.
 */
export function carryPlan(serving, build, serve, keepBuilds) {
  if (!serving || keepBuilds === 0) return []
  const current = new Set(build.files.map((f) => f.path))
  const sameBuild = serving.build === build.hash
  const out = []
  if (!sameBuild && serving.files) for (const [path, hash] of serving.files) if (!current.has(path)) out.push({ path, sha256: hash, age: 1 })
  for (const k of serving.kept) if (!current.has(k.path) && !out.some((o) => o.path === k.path)) out.push({ path: k.path, sha256: k.sha256, age: sameBuild ? k.age : k.age + 1 })
  return out
    .filter((f) => Number.isInteger(f.age) && f.age >= 1 && f.age <= keepBuilds)
    // Only a hashed asset of a known type and a plain name is ever fetched and uploaded again.
    .filter((f) => f.path.startsWith(serve.assetsPrefix) && f.path.slice(1).split('/').every((s) => SEGMENT.test(s)) && Boolean(serve.contentTypes[extname(f.path)]) && /^[0-9a-f]{64}$/.test(f.sha256))
    .sort((a, b) => a.age - b.age || a.path.localeCompare(b.path))
}

/**
 * Writes the directory wrangler uploads: the build's files (never index.html, which the Worker
 * serves from its variable), the kept files as given (`{ path, sha256, age, body }`), and `_headers`.
 * Returns `{ hash, files, bytes }` of what is there.
 */
export function stageBuild({ dist, build, serve, outDir, kept = [] }) {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  for (const f of build.files) {
    const to = join(outDir, f.path.slice(1))
    mkdirSync(dirname(to), { recursive: true })
    cpSync(join(dist, f.path.slice(1)), to)
  }
  for (const k of kept) {
    const to = join(outDir, k.path.slice(1))
    if (existsSync(to)) continue
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, k.body)
  }
  writeFileSync(join(outDir, '_headers'), headersFile(serve))
  return hashStaged(outDir)
}

/** One hash over every file of a staged directory, `_headers` included. */
export function hashStaged(dir) {
  if (!existsSync(dir)) return null
  const h = createHash('sha256')
  let total = 0
  const files = filesUnder(dir)
  for (const rel of files) {
    const body = readFileSync(join(dir, rel))
    total += body.length
    h.update(`${rel}\0${sha256(body)}\n`)
  }
  return { hash: h.digest('hex'), files: files.length, bytes: total }
}

// ---- the stamp ----

export const stampPath = (targetDir) => join(targetDir, 'app.json')
export const stagedDir = (targetDir) => join(targetDir, 'app')
export const buildDir = (targetDir) => join(targetDir, 'app-build')

export function readStamp(targetDir) {
  const file = stampPath(targetDir)
  if (!existsSync(file)) return null
  const s = JSON.parse(readFileSync(file, 'utf8'))
  if (s?.v !== STAMP_VERSION) throw new Error(`${file}: not an app stamp of version ${STAMP_VERSION}`)
  return s
}

/**
 * Stages a built `dist` for one release and writes its stamp. `sources` is what listSources and
 * hashSources saw BEFORE the build; `via` how the build was made; `kept` the earlier builds' files,
 * fetched and verified by the caller; `dropped` those it could not keep, with why.
 */
export function stampBuild({ targetDir, repoRoot, release, target, serveFile, dist, sources, via, kept = [], dropped = [], carry = { skipped: 'not asked' } }) {
  if (via !== 'export' && via !== 'prebuilt') throw new Error('stampBuild: via must be "export" (built here, from an export of the sources) or "prebuilt" (a build made elsewhere: a stage only)')
  const serve = readServe(serveFile)
  const build = readBuild(dist, serve)
  const filesVar = appFilesVar(build, kept)
  const fits = new Set(filesVar.kept.map((k) => k.path))
  const keptIn = kept.filter((k) => fits.has(k.path))
  const droppedAll = [...dropped, ...kept.filter((k) => !fits.has(k.path)).map((k) => ({ path: k.path, why: `${APP_FILES_VAR} holds ${VAR_MAX_BYTES} bytes` }))]
  const out = stagedDir(targetDir)
  const staged = stageBuild({ dist, build, serve, outDir: out, kept: keptIn })
  const stamp = {
    v: STAMP_VERSION,
    release,
    target,
    builtAt: new Date().toISOString(),
    // "export": built by deploy/app.mjs from an export of exactly `sources`. "prebuilt": a dist/ handed in, which nothing ties to them.
    via,
    sources,
    serve: { file: relative(repoRoot, serveFile).split(sep).join('/'), sha256: serve.sha256, documents: serve.documents, assetsPrefix: serve.assetsPrefix, files: serve.files, headers: serve.headers, contentTypes: serve.contentTypes },
    build: { hash: build.hash, document: { sha256: build.documentSha256, bytes: bytes(build.document), etag: documentEtag(build.documentSha256) }, files: build.files, bytes: build.files.reduce((n, f) => n + f.bytes, 0) },
    kept: keptIn.map(({ path, sha256: h, age }) => ({ path, sha256: h, age })),
    dropped: droppedAll,
    carry,
    staged: { dir: relative(repoRoot, out).split(sep).join('/'), ...staged },
    vars: { [APP_VAR]: appVar(serve, build), [APP_FILES_VAR]: filesVar.text },
  }
  writeFileSync(stampPath(targetDir), JSON.stringify(stamp, null, 2) + '\n')
  return stamp
}

/** What the manifest, the release record and the logs say of a stamped build. */
export const appSummary = (stamp) => ({
  build: stamp.build.hash,
  document: stamp.build.document,
  files: stamp.build.files.length,
  bytes: stamp.build.bytes,
  kept: stamp.kept.map((k) => ({ path: k.path, age: k.age })),
  dropped: stamp.dropped,
  via: stamp.via,
  sources: { hash: stamp.sources.hash, commit: stamp.sources.commit, dirty: stamp.sources.dirty, files: stamp.sources.files },
  carry: stamp.carry,
  serve: stamp.serve,
  staged: stamp.staged,
})

/**
 * Why a stamped build may not be released, each a sentence; empty when it may. Checked by
 * configure.mjs when it writes the config and again by release.mjs before anything is uploaded:
 *
 * - no stamp, or one of another release or target: the build is missing or left from another run;
 * - the sources changed since the build (their hash differs), or serve.json did: the build is stale;
 * - the staged directory is not what was stamped (a file changed, added or gone);
 * - for production, when the release is a commit: the checkout is not that commit, or its sources
 *   differ from it. A stage may be built from a work tree with changes; the stamp says so.
 */
export function stampProblems({ targetDir, repoRoot, release, target, app, stage }) {
  let stamp
  try {
    stamp = readStamp(targetDir)
  } catch (e) {
    return { stamp: null, problems: [e.message] }
  }
  const rel = (p) => relative(repoRoot, p).split(sep).join('/')
  const how = `node deploy/app.mjs build${stage ? ` --stage ${stage}` : ''} --release ${release}`
  if (!stamp) return { stamp: null, problems: [`the app has not been built for this release: ${rel(stampPath(targetDir))} is missing. Build it first (${how}); deploy.sh does`] }
  const problems = []
  if (stamp.release !== release) problems.push(`the app build in ${rel(stagedDir(targetDir))} is of release ${stamp.release}, not ${release}: stale. Build it again (${how})`)
  if (stamp.target !== target) problems.push(`the app build was staged for ${stamp.target}, not ${target}`)
  if (!stage && stamp.via !== 'export') problems.push(`the app build for production was not made by deploy/app.mjs from this checkout's sources (it is "${stamp.via}"): nothing ties it to the release. Build it (${how})`)
  const staged = hashStaged(join(repoRoot, stamp.staged.dir))
  if (rel(stagedDir(targetDir)) !== stamp.staged.dir) problems.push(`the app stamp names ${stamp.staged.dir}, not ${rel(stagedDir(targetDir))}`)
  if (!staged) problems.push(`the staged app build ${stamp.staged.dir} is missing. Build it again (${how})`)
  else if (staged.hash !== stamp.staged.hash) problems.push(`the staged app build ${stamp.staged.dir} is not what was built (its files changed after the stamp was written). Build it again (${how})`)
  let now
  try {
    const serve = readServe(join(repoRoot, app.serve))
    if (serve.sha256 !== stamp.serve.sha256) problems.push(`${app.serve} changed after the app was built: the build is staged by other rules than the gateway would be configured with. Build it again (${how})`)
    now = listSources(repoRoot, app)
    if (hashSources(repoRoot, now.files) !== stamp.sources.hash) problems.push(`the app's sources changed after it was built (${app.dir}/${app.needs.length ? `, ${app.needs.join('/, ')}/` : ''}): the build is stale. Build it again (${how})`)
  } catch (e) {
    problems.push(e.message)
  }
  if (!stage && /^[0-9a-f]{40}$/.test(release) && now?.by === 'git') {
    if (now.commit !== release) problems.push(`the release is commit ${release}, and this checkout is at ${now.commit ?? 'no commit'}: the app would be built from other sources than the release names`)
    else if (now.dirty) problems.push(`the release is commit ${release}, and the app's sources differ from it in this checkout (${now.dirtyFiles.join(', ')})`)
  }
  return { stamp, problems }
}

// ---- building ----

function run(cmd, args, cwd) {
  // The build runs third-party packages' code: it gets no Cloudflare credential.
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (/^(CLOUDFLARE_|CF_API|SMOKE_KEY$|WRANGLER_)/.test(k)) delete env[k]
  const r = spawnSync(cmd, args, { cwd, env, stdio: ['ignore', 2, 2] })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd} (exit ${r.status ?? r.signal})`)
}

/**
 * Exports the sources to `<targetDir>/app-build/` and builds the app there: `npm ci` in each
 * directory that has a lockfile, then the app's own `npm run build` (which generates the design
 * system's dist/ first). Never builds in the checkout: a build there rewrites generated files under
 * whoever else is working in it, and could pick up ignored files that no fresh checkout has.
 * `skipInstall`: link the checkout's node_modules instead of `npm ci` (a shared machine, offline).
 * Returns the built `dist` directory.
 */
export function exportAndBuild({ repoRoot, targetDir, app, files, skipInstall = false, log = () => {} }) {
  const out = buildDir(targetDir)
  rmSync(out, { recursive: true, force: true })
  for (const p of files) {
    const to = join(out, p)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(join(repoRoot, p), to)
  }
  for (const d of [...app.needs, app.dir]) {
    const dir = join(out, d)
    if (skipInstall) {
      const have = join(repoRoot, d, 'node_modules')
      if (!existsSync(have)) throw new Error(`${d}/node_modules is missing, and the install was to be skipped`)
      symlinkSync(have, join(dir, 'node_modules'), 'dir')
      log(`  ${d}: node_modules linked from the checkout (install skipped)`)
    } else if (existsSync(join(dir, 'package-lock.json'))) {
      log(`  ${d}: npm ci`)
      run('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error'], dir)
    }
  }
  log(`  ${app.dir}: npm run build`)
  run('npm', ['run', 'build'], join(out, app.dir))
  const dist = join(out, app.dir, 'dist')
  if (!existsSync(join(dist, 'index.html'))) throw new Error(`the app's build left no ${relative(repoRoot, dist)}/index.html`)
  return dist
}

/**
 * Fetches the files `plan` names from the deployment serving now and keeps those whose bytes have
 * the recorded SHA-256. A file that cannot be had (the serving version no longer holds it, the
 * network) is dropped with its reason, never a failure of the release: it only matters to pages
 * opened before earlier deploys.
 */
export async function fetchKept(plan, origin, { fetchFile = defaultFetchFile } = {}) {
  const kept = []
  const dropped = []
  for (const f of plan) {
    try {
      const body = await fetchFile(`${origin}${f.path}`)
      if (body.length > ASSET_MAX_BYTES) throw new Error(`${body.length} bytes`)
      if (sha256(body) !== f.sha256) throw new Error('its bytes are not the ones recorded')
      kept.push({ ...f, body })
    } catch (e) {
      dropped.push({ path: f.path, why: String(e.message ?? e).slice(0, 200) })
    }
  }
  return { kept, dropped }
}

async function defaultFetchFile(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'viz-deploy-app/1' }, redirect: 'error', signal: AbortSignal.timeout(30_000) })
  if (res.status !== 200) {
    await res.body?.cancel()
    throw new Error(`HTTP ${res.status}`)
  }
  return Buffer.from(await res.arrayBuffer())
}
