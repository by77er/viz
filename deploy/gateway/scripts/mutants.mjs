#!/usr/bin/env node
// Mutation check for the gateway (AGENTS.md, "Tests must have teeth"): each mutant is one text
// replacement in gateway/src/index.ts; the gateway's tests must fail with it. The source is
// restored after every mutant, also on failure.
//
//   node gateway/scripts/mutants.mjs [name substring]       (from deploy/)
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEPLOY_DIR } from '../../lib/common.mjs'

const SRC = join(DEPLOY_DIR, 'gateway', 'src', 'index.ts')
const MUTANTS = [
  ['bootstrap accepts any token', 'if (token === null || !match) return json(401', 'if (false) return json(401'],
  ['bootstrap ignores the expiry', 'if (now >= secret.expiresAt) return', 'if (false) return'],
  ['bootstrap accepts a body or query string', "if (url.search !== '' || body.byteLength > 0) {", 'if (false) {'],
  ['bootstrap exists without the secret', 'if (!env.VIZ_BOOTSTRAP) return notFound()', "if (!env.VIZ_BOOTSTRAP) env = { ...env, VIZ_BOOTSTRAP: '{}' }"],
  ['no x-viz-route on forwarded answers', "out.headers.set('x-viz-route', backend)", '// header dropped'],
  ['the response body is buffered', 'const out = new Response(res.body, res)', 'const out = new Response(await res.arrayBuffer(), res)'],
  ['status text is dropped', 'const out = new Response(res.body, res)', 'const out = new Response(res.body, { status: res.status, headers: res.headers })'],
  ['a query prefix is too wide', "const QUERY_PREFIXES = ['/api/v1/label/', '/api/v1/status/']", "const QUERY_PREFIXES = ['/api/v1/label', '/api/v1/status/']"],
  ['control prefix matches /api/v1/controls', 'path.startsWith(`${CONTROL_ROOT}/`)', 'path.startsWith(CONTROL_ROOT)'],
  ['healthy when any backend is', 'const healthy = results.every((r) => r.ok)', 'const healthy = results.some((r) => r.ok)'],
  ['control health probes the OpenAPI document again', "  control: '/healthz',", "  control: '/api/v1/control/openapi.json',"],
  ['bootstrap answers a schema_too_new refusal with 500', '    if (/^schema_too_new/.test(message)) {', '    if (false) {'],
  ['a throwing backend crashes the gateway', 'res = await env[BINDING[backend]].fetch(req)\n  } catch (e) {', 'res = await env[BINDING[backend]].fetch(req)\n  } catch (e) {\n    throw e'],
  ['monitors prefix matches /api/v1/monitorsx', 'path.startsWith(`${MONITORS_ROOT}/`)', 'path.startsWith(MONITORS_ROOT)'],
  ['/mcp matched as a prefix (/mcpx, /mcp/x reach the agent surface)', 'if (path === MCP_PATH || path === AGENT_ROOT', 'if (path.startsWith(MCP_PATH) || path === AGENT_ROOT'],
  ['agent prefix matches /api/v1/agents', 'path.startsWith(`${AGENT_ROOT}/`)', 'path.startsWith(AGENT_ROOT)'],
  ['the ruler is left out of /healthz', "const names: Backend[] = ['ingest', 'query', 'control', 'ruler', 'mcp']", "const names: Backend[] = ['ingest', 'query', 'control', 'mcp']"],
  ['OAuth: the authorization server\'s paths are not routed (MCP clients cannot register or get tokens)', ' || CONTROL_OAUTH_PATHS.has(path)) return \'control\'', ") return 'control'"],
  ['OAuth: /oauth/ and the metadata matched as prefixes (/oauth/x, /.well-known/oauth-authorization-server/x reach control)', ' || CONTROL_OAUTH_PATHS.has(path)) return \'control\'', " || path.startsWith('/oauth/') || path.startsWith('/.well-known/oauth-authorization-server')) return 'control'"],
  ['OAuth: the protected resource metadata goes to control instead of mcp', ' || MCP_OAUTH_PATHS.has(path)) return \'mcp\'', ") return 'mcp'\n  if (MCP_OAUTH_PATHS.has(path)) return 'control'"],
  ['the ruler\'s paths go to the query service (both speak the Prometheus API)', "  if (RULER_PATHS.has(path) || path === MONITORS_ROOT || path.startsWith(`${MONITORS_ROOT}/`)) return 'ruler'", "  if (RULER_PATHS.has(path) || path === MONITORS_ROOT || path.startsWith(`${MONITORS_ROOT}/`)) return 'query'"],
  // Traces and logs, stage 3: the ingest and read paths of spans and logs
  ['a trace path goes to ingest (OTLP traces and Tempo share /api/traces/…)', "if (INGEST_PATHS.has(path) || SIGNAL_INGEST_PATHS.has(path)) return 'ingest'", "if (INGEST_PATHS.has(path) || SIGNAL_INGEST_PATHS.has(path) || path.startsWith('/api/traces/')) return 'ingest'"],
  ['every /loki/ path goes to ingest (where the push is served)', "if (INGEST_PATHS.has(path) || SIGNAL_INGEST_PATHS.has(path)) return 'ingest'", "if (INGEST_PATHS.has(path) || SIGNAL_INGEST_PATHS.has(path) || path.startsWith('/loki/')) return 'ingest'"],
  ['the span and log ingest paths are not routed', "if (INGEST_PATHS.has(path) || SIGNAL_INGEST_PATHS.has(path)) return 'ingest'", "if (INGEST_PATHS.has(path)) return 'ingest'"],
  ['the Tempo and Loki read paths are not routed', "  if (SIGNAL_QUERY_PATHS.has(path) || SIGNAL_QUERY_PATTERNS.some((p) => p.test(path))) return 'query'\n", ''],
  ['a trace id matched as a prefix (/api/traces/abc/x reaches query)', 'traces\\/[^/]+$/', 'traces\\//'],
  ['/api/v1/plan is not routed (the plan-only endpoint is unreachable from outside)', "'/api/v1/metadata', '/api/v1/plan'])", "'/api/v1/metadata'])"],
  ['Tempo\'s /api/echo is not routed (a Grafana data source\'s check gets 404)', "  '/api/echo',\n", ''],
  ['/api/echo matched as a prefix (/api/echo/x, /api/echox reach query)', "  if (SIGNAL_QUERY_PATHS.has(path) || SIGNAL_QUERY_PATTERNS", "  if (path.startsWith('/api/echo') || SIGNAL_QUERY_PATHS.has(path) || SIGNAL_QUERY_PATTERNS"],
  ['every /loki/ path goes to query (/loki/api/v1/tail, index, rules reach it)', "  if (SIGNAL_QUERY_PATHS.has(path) || SIGNAL_QUERY_PATTERNS", "  if (path.startsWith('/loki/') || SIGNAL_QUERY_PATHS.has(path) || SIGNAL_QUERY_PATTERNS"],
  // The web app (D74): the documents, and what every other path gets
  ['app: an unknown path is answered with the document (a single-page fallback: an unknown API path, a missing asset get HTML)', '  if (route === null) return appDocument(req, env, path) ?? notFound()', "  if (route === null) return appDocument(req, env, path) ?? (appOf(env) && req.method === 'GET' ? new Response(appOf(env)!.document, { headers: appOf(env)!.headers }) : notFound())"],
  ['app: only an unknown path under /api/ keeps the JSON 404; any other unknown path gets the document', '  if (route === null) return appDocument(req, env, path) ?? notFound()', "  if (route === null) return appDocument(req, env, path) ?? (appOf(env) && req.method === 'GET' && !path.startsWith('/api') ? new Response(appOf(env)!.document, { headers: appOf(env)!.headers }) : notFound())"],
  ['app: the document is served without its Content-Security-Policy', "  headers.set('ETag', app.etag)\n", "  headers.set('ETag', app.etag)\n  headers.delete('Content-Security-Policy')\n"],
  ['app: the document is served to be kept for good (an asset\'s caching)', "  headers.set('ETag', app.etag)\n", "  headers.set('ETag', app.etag)\n  headers.set('Cache-Control', 'public, max-age=31536000, immutable')\n"],
  ['app: the document loses one of its other headers (X-Frame-Options)', "  headers.set('ETag', app.etag)\n", "  headers.set('ETag', app.etag)\n  headers.delete('X-Frame-Options')\n"],
  ['app: any method is served the document (POST, DELETE)', "  if (req.method !== 'GET' && req.method !== 'HEAD') return null\n", ''],
  ['app: a trailing slash is the document too (/explore/)', '  if (app === null || !app.documents.has(path)) return null', "  if (app === null || !app.documents.has(path.replace(/\\/+$/, '') || '/')) return null"],
  ['app: document paths compared without case (/Explore)', '  if (app === null || !app.documents.has(path)) return null', '  if (app === null || !app.documents.has(path.toLowerCase())) return null'],
  ['app: a path is decoded before it is compared (/%65xplore)', '  if (app === null || !app.documents.has(path)) return null', '  if (app === null || !app.documents.has(decodeURIComponent(path))) return null'],
  ['app: document paths matched as prefixes (/explorer, /explore/x, /index.html under /)', '  if (app === null || !app.documents.has(path)) return null', '  if (app === null || ![...app.documents].some((d) => path.startsWith(d))) return null'],
  ['app: a VIZ_APP without a Content-Security-Policy is served', "    if (!lower.get('content-security-policy') || !/^text", '    if (!/^text'],
  ['app: a VIZ_APP whose document a cache may keep is served', " || !/\\bno-cache\\b|\\bno-store\\b/.test(lower.get('cache-control') ?? '')) return null", ') return null'],
  ['app: a VIZ_APP that names an API path as a document is accepted', " && p.startsWith('/') && routeOf(p) === null)) return null", " && p.startsWith('/'))) return null"],
  ['app: HEAD of a document answers with the body', "  return new Response(req.method === 'HEAD' ? null : app.document, { status: 200, headers })", '  return new Response(app.document, { status: 200, headers })'],
  ['app: any If-None-Match gets 304 (a page holding another build is told it is current)', "    return tag === '*' || tag === etag || tag === `W/${etag}`", '    return true'],
  ['app: a revalidation never gets 304', "  if (matchesEtag(req.headers.get('If-None-Match'), app.etag)) return new Response(null, { status: 304, headers })\n", ''],
  ['app: a weakened entity tag (a compressing proxy) is not recognised', "    return tag === '*' || tag === etag || tag === `W/${etag}`", "    return tag === '*' || tag === etag"],
  ['app: the document carries no entity tag', "  headers.set('ETag', app.etag)\n", ''],
  ['app: documents answer without x-viz-route', "  headers.set('x-viz-route', 'app')\n", ''],
]

// It edits gateway/src/index.ts in place: run it in a copy outside any git work tree
// (AGENTS.md: a mutant caught in a commit ships). The copy needs deploy/ (with node_modules),
// control/{src,openapi.json}, edge/src, dashboard/src and contracts/, which the tests import, and
// app/serve.json, which the tests and vitest.config.ts read.
try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: DEPLOY_DIR, stdio: 'pipe' })
  console.error('Refusing to mutate sources inside a git work tree. Copy the tree first (see above).')
  process.exit(2)
} catch {
  // Not a work tree (or no git): a copy. Go on.
}

const original = readFileSync(SRC, 'utf8')
const results = []
try {
  for (const [name, from, to] of MUTANTS) {
    if (process.argv[2] && !name.includes(process.argv[2])) continue
    if (!original.includes(from)) throw new Error(`mutant "${name}": text not found in the source`)
    writeFileSync(SRC, original.replace(from, to))
    let killed = false
    let failed = ''
    const dir = mkdtempSync(join(tmpdir(), 'viz-mutant-'))
    const out = join(dir, 'report.json')
    try {
      execFileSync('npx', ['vitest', 'run', '--maxWorkers=2', '--reporter=json', `--outputFile=${out}`], { cwd: DEPLOY_DIR, stdio: 'ignore', timeout: 600_000 })
    } catch {
      // Only a test that ran and failed kills a mutant. A suite that crashed, hung or wrote no
      // report gave no result: reported as such and counted as not killed (rerun it).
      try {
        const report = JSON.parse(readFileSync(out, 'utf8'))
        const titles = report.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === 'failed').map((a) => a.title))
        killed = titles.length > 0
        failed = killed ? `${titles.length} failed, e.g. "${titles[0]}"` : '(no test failed: the suite did not load or run)'
      } catch {
        failed = '(NO RESULT: the suite did not finish; rerun)'
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    results.push({ name, killed, failed })
    console.log(`${killed ? 'killed  ' : 'SURVIVED'} ${name}${failed ? ` — ${failed}` : ''}`)
  }
} finally {
  writeFileSync(SRC, original)
}
const survived = results.filter((r) => !r.killed)
console.log(`${results.length - survived.length} of ${results.length} killed`)
process.exit(survived.length ? 1 : 0)
