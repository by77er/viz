#!/usr/bin/env node
/**
 * Mutation checks (AGENTS.md, "Tests must have teeth"). Each mutant breaks one safety
 * property in the source, the whole suite runs, the source is restored. A mutant is killed
 * when at least one test fails. The table printed at the end is what the README lists.
 *
 *   node scripts/mutants.mjs          all mutants
 *   node scripts/mutants.mjs 3 7      only these
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// It edits sources in place: run it in a copy outside any git work tree (AGENTS.md: a mutant
// caught in a commit ships). The copy needs mcp/ (with node_modules), control/{src,openapi.json},
// dashboard/{src,examples,schema,package.json}, edge/src, contracts/ and ruler/openapi.json, which
// the tests import.
try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'pipe' })
  console.error('Refusing to mutate sources inside a git work tree. Copy the tree first (see above).')
  process.exit(2)
} catch {
  // Not a work tree (or no git): a copy. Go on.
}

/** Each change is [file, exact text (must occur once), replacement]. */
const MUTANTS = [
  {
    name: 'Tenant taken from a request header (X-Viz-Tenant) instead of the credential',
    changes: [['src/index.ts', `caller = { id: await identify(req, env, probe ? (a: string) => make.control(env, a)! : null), downstream: authorization }`, `caller = { id: { ...(await identify(req, env, probe ? (a: string) => make.control(env, a)! : null)), ...(req.headers.get('X-Viz-Tenant') ? { tenant: req.headers.get('X-Viz-Tenant')! } : {}) }, downstream: authorization }`]],
  },
  {
    name: 'Agent apply allowed: whoami\'s mayApply is not consulted before writing',
    changes: [
      ['src/tools/write.ts', "if (s.id.mayApply === false) refuseApply(", 'if (false) refuseApply('],
      ['src/tools/write.ts', "if (s.id.mayApply !== true) refuseApply(", 'if (false) refuseApply('],
    ],
  },
  {
    name: 'Dry run writes: the control-plane check is sent without dryRun',
    changes: [['src/tools/write.ts', "? s.control!.call('PATCH', `/dashboards/${encodeURIComponent(id)}`, { body: { ops: flatOps, baseRevision: base, ...(message ? { message } : {}), dryRun: true } })", "? s.control!.call('PATCH', `/dashboards/${encodeURIComponent(id)}`, { body: { ops: flatOps, baseRevision: base, ...(message ? { message } : {}), dryRun: false } })"]],
  },
  {
    name: 'Preview digests skipped: changed panels are not run',
    changes: [['src/tools/write.ts', `previews = await runPanels(s, resolved, changed.ids.slice(0, s.limits.maxPanels), r, { topK: 3, checkNames: true })`, `previews = []`]],
  },
  {
    name: 'Injection outside the data field: the dashboard title in read_dashboard\'s header',
    changes: [['src/tools/dashboards.ts', '`read_dashboard: revision ${n} (', '`read_dashboard: ${spec.metadata.title}; revision ${n} (']],
  },
  {
    name: 'Budget ignored: pages are laid out for 32,000 tokens whatever max_tokens says',
    changes: [['src/tool.ts', 'budgetChars: charsFor(p.maxTokens)', 'budgetChars: charsFor(32000)']],
  },
  {
    name: 'Cursor repeats: the next page starts at the last item shown',
    changes: [['src/page.ts', 'const next = i < total ? i : null', 'const next = i < total ? Math.max(offset + (shown.length > 1 ? 1 : 0), i - 1) : null']],
  },
  {
    name: 'Telemetry URL rendered as a link: URLs are not defanged',
    changes: [['src/untrusted.ts', ".replace(URL_SCHEME, (_m, scheme: string) => `${scheme.replace(/t/gi, 'x')}[://]`)", '']],
  },
  {
    name: 'Did-you-mean leaks another tenant\'s names: the names cache is not keyed by tenant',
    changes: [['src/session.ts', 'const key = s.id.tenant', "const key = 'all'"]],
  },
  {
    name: 'Raw series by default: query defaults to format "series"',
    changes: [['src/tools/query.ts', "?? 'digest'", "?? 'series'"]],
  },
  {
    name: 'Control characters and invisible text not neutralised',
    changes: [['src/untrusted.ts', ".replace(INVISIBLE, '\uFFFD')", '']],
  },
  {
    name: 'Long values not cut',
    changes: [['src/untrusted.ts', 'if (s.length <= max) return s', 'return s']],
  },
  {
    name: 'Role tags and special tokens not neutralised',
    changes: [['src/untrusted.ts', '.replace(ROLE_TAG, (_m, tag: string) => `(${tag})`)', '']],
  },
  {
    name: 'Deadline ignored: queries are started and awaited past it',
    changes: [
      ['src/session.ts', 'if (remaining() <= 0) {', 'if (false) {'],
      ['src/session.ts', 'await Promise.race([all, stop])', 'await all'],
      // The deadline is enforced twice: nothing starts after it, and what is in flight is aborted.
      // The first version of this mutant removed only the first and survived (README, "Mutation checks").
      ['src/session.ts', "ctrl.abort(new DOMException('deadline', 'TimeoutError'))", 'void ctrl'],
    ],
  },
  {
    name: 'Parallelism unbounded: every query in flight at once',
    changes: [['src/session.ts', 'Math.max(1, Math.min(limit, items.length))', 'Math.max(1, items.length)']],
  },
  {
    name: 'Scope check skipped in the dispatcher',
    changes: [['src/dispatch.ts', 'if (!hasScopes(s.id, tool.scopes)) {', 'if (false) {']],
  },
  {
    name: 'Cursor accepted for other arguments',
    changes: [['src/page.ts', 'if (c.a !== argsHash(args)) throw', 'if (false) throw']],
  },
  {
    name: 'Revoked key accepted: a control-plane 401 falls back to edge\'s cached answer',
    changes: [['src/auth.ts', "if (who.status === 401) throw unauthenticated('The API key is disabled, expired or deleted.')", 'void 0']],
  },
  {
    name: 'A tenant in the query string is ignored instead of refused',
    changes: [['src/index.ts', "if (url.searchParams.has('tenant')) return problem(", "if (false) return problem("]],
  },
  {
    name: 'Unknown metric names not checked in the write preview (no did-you-mean)',
    changes: [['src/tools/common.ts', 'for (const sel of selectorsOf(parsePromQL(rq.expr).ast)) {', 'for (const sel of [] as ReturnType<typeof selectorsOf>) {']],
  },
  {
    name: 'No answer on mayApply (an older control release, or edge\'s fallback) is taken as yes',
    changes: [['src/tools/write.ts', "if (s.id.mayApply !== true) refuseApply(", 'if (false) refuseApply(']],
  },
  {
    name: 'A proposed new dashboard is sent as a direct create',
    changes: [['src/tools/write.ts', "s.control.call('POST', '/proposals', { body: { spec: candidate,", "s.control.call('POST', '/dashboards', { body: { spec: candidate,"]],
  },
  {
    name: 'read_dashboard lists panels in structure in layout order, not the order the text uses',
    changes: [['src/tools/dashboards.ts', 'const ordered = panelOrder(panels).map((i) => ({ p: panels[i]!, i }))', 'const ordered = panels.map((p, i) => ({ p, i }))']],
  },
  {
    name: '`validate_query` does not ask the query service for its plan (the estimate is the series count alone)',
    changes: [['src/tools/validate.ts', 'if (performance.now() < s.deadline) {\n        s.usage.upstreamCalls++\n        const p = await s.query.plan(', 'if (false) {\n        s.usage.upstreamCalls++\n        const p = await s.query.plan(']],
  },
  {
    name: '`validate_query` drops the refusal the plan foresees',
    changes: [['src/tools/validate.ts', 'if (plan.refusal) findings.push(', 'if (plan.refusal && false) findings.push(']],
  },
  {
    name: '`/healthz` says ok whatever is bound',
    changes: [['src/index.ts', "const missing = (['CONFIG', 'QUERY', 'CONTROL', 'RULER', 'OAUTH'] as const).filter((b) => !env[b])", 'const missing: string[] = []']],
  },
  // 27–33: OAuth at the resource (D44, contracts/oauth.ts)
  {
    name: 'OAuth: token passthrough (downstream calls carry the client\'s access token, not the grant\'s key)',
    changes: [['src/auth.ts', 'downstream: `Bearer ${r.credential}`,', 'downstream: `Bearer ${presented.token}`,']],
  },
  {
    name: 'OAuth: audience not this resource (introspection asked about the token\'s own resource, whatever this server is configured as)',
    changes: [['src/index.ts', 'caller = await identifyOAuth(oauth, env, cfg.resource)', "caller = await identifyOAuth(oauth, env, 'https://vis.bitcru.sh/mcp')"]],
  },
  {
    name: 'OAuth: the JSON agent API accepts access tokens (audience widened)',
    changes: [['src/index.ts', "          if (!isMcp) throw new AuthError(401, 'wrong-audience',", "          if (false) throw new AuthError(401, 'wrong-audience',"]],
  },
  {
    name: 'OAuth: no 403 insufficient_scope (step-up never signalled)',
    changes: [['src/index.ts', 'const denied = await stepUp(req, session.id, cfg)', 'const denied = null as Response | null']],
  },
  {
    name: 'OAuth: the 401 challenge does not name the protected resource metadata',
    changes: [['src/oauth.ts', 'const parts = [`realm="viz"`, `resource_metadata=${q(cfg.metadataUrl)}`,', 'const parts = [`realm="viz"`,']],
  },
  {
    // Replaces "the tenant object asked is the one a request header names" (review of D44, M-1):
    // this Worker no longer picks a tenant's object at all; control's entrypoint takes the tenant
    // from the token (control's mutants "review M-1" and "review M-2" cover that side).
    name: 'OAuth: a binding control does not accept (props naming another caller) is taken for an unknown token (401), not a deployment fault (503)',
    changes: [['src/auth.ts', "  if (r?.status === 'unauthorized') throw new AuthError(503, 'oauth-unavailable',", "  if (r?.status === 'unauthorized') throw new AuthError(401, 'invalid-token',"]],
  },
  {
    name: 'OAuth: protected resource metadata names no authorization server',
    changes: [['src/oauth.ts', '    authorization_servers: [cfg.issuer],', '    authorization_servers: [],']],
  },
  // 34–39: backtest_monitor
  {
    name: 'backtest_monitor: tenant taken from the arguments (accepted by the schema and sent to the ruler)',
    changes: [
      ['src/tools/backtest.ts', '      monitor: MONITOR_ARG,', "      monitor: MONITOR_ARG,\n      tenant: { type: 'string', maxLength: 200 },"],
      ['src/tools/backtest.ts', 'const req = { monitor: { ...monitor }, fromMs: range.fromMs, toMs: range.toMs, step: durText(range.stepMs) }', 'const req = { monitor: { ...monitor }, fromMs: range.fromMs, toMs: range.toMs, step: durText(range.stepMs), ...(args.tenant ? { tenant: args.tenant } : {}) }'],
    ],
  },
  {
    name: 'backtest_monitor: a refusal swallowed and answered as an empty backtest',
    changes: [['src/tools/backtest.ts', 'if (!answer.ok) throw refusal(answer, { kind: asked, range, monitor }, s)', "if (!answer.ok) return pagedResult({ tool: this.name, s, args, maxTokens: 1500, header: 'backtest_monitor: would not have fired.\\n', items: [], offset: 0 })"]],
  },
  {
    name: 'backtest_monitor: intervals past the listing cap dropped without the count (text)',
    changes: [['src/tools/backtest.ts', '${omitted ? `; the first ${grouped(listed.length)} are listed, ${grouped(omitted)} more (${grouped(omittedFiring)} firing, ${grouped(omitted - omittedFiring)} pending) are only counted above` : \'\'}', '']],
  },
  {
    name: 'backtest_monitor: intervals past the listing cap dropped without the count (structure)',
    changes: [['src/tools/backtest.ts', 'intervals: { total: sorted.length, listed: listed.length, omitted, omittedFiring, malformed },', 'intervals: { total: listed.length, listed: listed.length, omitted: 0, omittedFiring: 0, malformed },']],
  },
  {
    name: 'backtest_monitor: over_budget does not say which budget (plan, memory, cpu) refused',
    changes: [['src/tools/backtest.ts', 'const { budget, reason } = whichBudget(ob, rulerMessage)', "const { budget, reason } = { budget: 'unknown' as BudgetName, reason: 'unknown' as Reason }"]],
  },
  {
    name: 'backtest_monitor: a refusal retried once',
    changes: [['src/tools/backtest.ts', 'const answer = await ruler.backtest(req, { signal: AbortSignal.timeout(s.limits.backtestTimeoutMs) })', 'let answer = await ruler.backtest(req, { signal: AbortSignal.timeout(s.limits.backtestTimeoutMs) })\n    if (!answer.ok) answer = await ruler.backtest(req, { signal: AbortSignal.timeout(s.limits.backtestTimeoutMs) })']],
  },
  // review of D44 (design/reviews/d44-d52-d53-d60.md)
  {
    name: 'review m-6: scopes compared literally (dashboards:apply does not cover dashboards:write)',
    changes: [['src/auth.ts', 'all.every((s) => (IMPLIED[s] ?? [s]).some((x) => id.scopes.includes(x)))', 'all.every((s) => id.scopes.includes(s))']],
  },
  {
    name: 'review m-2: the step-up check reads the whole body (no cap on one without Content-Length)',
    changes: [['src/index.ts', '    const bytes = await readCapped(req.clone(), STEP_UP_MAX_BYTES)\n    if (bytes === null) return null\n', '    const bytes = new Uint8Array(await req.clone().arrayBuffer())\n']],
  },
  // D70: control's introspection answers rate_limited over its limits
  {
    name: "D70: control's rate_limited not mapped (falls through to the retryable 503 for a status this release does not know)",
    changes: [['src/auth.ts', "  if (r?.status === 'rate_limited') {\n    const s = retryAfterSeconds(r.retryAfterMs)\n", "  if (false as boolean) {\n    const s = retryAfterSeconds((r as { retryAfterMs: number }).retryAfterMs)\n"]],
  },
  {
    name: 'D70: the 429 carries no Retry-After',
    changes: [['src/index.ts', "  if (e.retryAfterS !== undefined) headers['Retry-After'] = String(e.retryAfterS)\n", '']],
  },
]

const only = process.argv.slice(2).map(Number)
const out = mkdtempSync(join(tmpdir(), 'viz-mcp-mutants-'))
const rows = []
for (const [i, m] of MUTANTS.entries()) {
  const n = i + 1
  if (only.length && !only.includes(n)) continue
  const originals = new Map()
  try {
    for (const [file, from, to] of m.changes) {
      const path = join(root, file)
      const text = originals.get(path) ?? readFileSync(path, 'utf8')
      if (!originals.has(path)) originals.set(path, text)
      const current = readFileSync(path, 'utf8')
      const count = current.split(from).length - 1
      if (count !== 1) throw new Error(`mutant ${n}: expected exactly one occurrence in ${file}, found ${count}: ${from}`)
      writeFileSync(path, current.replace(from, to))
    }
    const report = join(out, `m${n}.json`)
    try {
      execFileSync('npx', ['vitest', 'run', '--maxWorkers=2', '--reporter=json', `--outputFile=${report}`], { cwd: root, stdio: 'ignore', timeout: 600_000 })
    } catch {
      /* a failing suite is what we want */
    }
    let r
    let noResult = false
    try {
      r = JSON.parse(readFileSync(report, 'utf8'))
    } catch {
      // The suite did not finish (it hung or timed out): reported as such, never as killed.
      r = { numFailedTests: 0, testResults: [] }
      noResult = true
    }
    const failedFiles = r.testResults.filter((f) => f.status === 'failed').map((f) => f.name.replace(/^.*\/test\//, '').replace('.test.ts', ''))
    const failedTests = r.numFailedTests
    rows.push({ n, name: m.name, killed: failedTests > 0, noResult, failedTests, by: failedFiles.join(', ') })
    console.log(`${n}\t${failedTests > 0 ? 'KILLED' : noResult ? 'NO RESULT (rerun)' : 'SURVIVED'}\t${failedTests} failing\t${failedFiles.join(', ')}\t${m.name}`)
  } finally {
    for (const [path, text] of originals) writeFileSync(path, text)
  }
}
rmSync(out, { recursive: true, force: true })
console.log('\n| # | Mutant | Caught by (failing tests) |\n|---|---|---|')
for (const r of rows) console.log(`| ${r.n} | ${r.name} | ${r.killed ? `${r.by} (${r.failedTests})` : r.noResult ? '**NO RESULT**' : '**SURVIVED**'} |`)
const survived = rows.filter((r) => !r.killed)
console.log(`\n${rows.length - survived.length} of ${rows.length} killed.`)
process.exit(survived.length ? 1 : 0)
