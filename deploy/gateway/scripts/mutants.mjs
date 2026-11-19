#!/usr/bin/env node
// Mutation check for the gateway (AGENTS.md, "Tests must have teeth"): each mutant is one text
// replacement in gateway/src/index.ts; the gateway's tests must fail with it. The source is
// restored after every mutant, also on failure.
//
//   node gateway/scripts/mutants.mjs        (from deploy/)
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
]

// It edits gateway/src/index.ts in place: run it in a copy outside any git work tree
// (AGENTS.md: a mutant caught in a commit ships). The copy needs deploy/ (with node_modules),
// control/src, edge/src, dashboard/src and contracts/, which the tests import.
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
    if (!original.includes(from)) throw new Error(`mutant "${name}": text not found in the source`)
    writeFileSync(SRC, original.replace(from, to))
    let killed = false
    let failed = ''
    const dir = mkdtempSync(join(tmpdir(), 'viz-mutant-'))
    const out = join(dir, 'report.json')
    try {
      execFileSync('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${out}`], { cwd: DEPLOY_DIR, stdio: 'ignore', timeout: 600_000 })
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
