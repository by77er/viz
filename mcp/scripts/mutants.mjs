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

/** Each change is [file, exact text (must occur once), replacement]. */
const MUTANTS = [
  {
    name: 'Tenant taken from a request header (X-Viz-Tenant) instead of the credential',
    changes: [['src/index.ts', `const id = await identify(req, env, control ? (a: string) => make.control(env, a)! : null)`, `const id = { ...(await identify(req, env, control ? (a: string) => make.control(env, a)! : null)), ...(req.headers.get('X-Viz-Tenant') ? { tenant: req.headers.get('X-Viz-Tenant')! } : {}) }`]],
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
    name: 'Unknown metric names not checked in the write preview (no did-you-mean)',
    changes: [['src/tools/common.ts', 'for (const sel of selectorsOf(parsePromQL(rq.expr).ast)) {', 'for (const sel of [] as ReturnType<typeof selectorsOf>) {']],
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
      execFileSync('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${report}`], { cwd: root, stdio: 'ignore', timeout: 600_000 })
    } catch {
      /* a failing suite is what we want */
    }
    let r
    try {
      r = JSON.parse(readFileSync(report, 'utf8'))
    } catch {
      // The suite did not finish (it hung or timed out): reported as such, never as killed.
      r = { numFailedTests: 0, testResults: [] }
    }
    const failedFiles = r.testResults.filter((f) => f.status === 'failed').map((f) => f.name.replace(/^.*\/test\//, '').replace('.test.ts', ''))
    const failedTests = r.numFailedTests
    rows.push({ n, name: m.name, killed: failedTests > 0, failedTests, by: failedFiles.join(', ') })
    console.log(`${n}\t${failedTests > 0 ? 'KILLED' : 'SURVIVED'}\t${failedTests} failing\t${failedFiles.join(', ')}\t${m.name}`)
  } finally {
    for (const [path, text] of originals) writeFileSync(path, text)
  }
}
rmSync(out, { recursive: true, force: true })
console.log('\n| # | Mutant | Caught by (failing tests) |\n|---|---|---|')
for (const r of rows) console.log(`| ${r.n} | ${r.name} | ${r.killed ? `${r.by} (${r.failedTests})` : '**SURVIVED**'} |`)
const survived = rows.filter((r) => !r.killed)
console.log(`\n${rows.length - survived.length} of ${rows.length} killed.`)
process.exit(survived.length ? 1 : 0)
