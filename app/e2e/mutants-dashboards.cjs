/* eslint-disable */
// "Tests must have teeth" (AGENTS.md, Evidence) for the dashboards views: break one safety
// property at a time in the source, run the checks, and record which fail. A mutant that no
// check catches is reported as SURVIVED.
//
// Mutants are applied to a COPY of the app, never in place in the shared tree: the app's
// source, mock, e2e and configuration are copied to VIZ_MUTANT_DIR (which must be given: a
// directory in the session's scratch area), node_modules, design-system and dashboard are
// linked, every mutant is applied, checked and undone there, and only the result file is
// written back to e2e/measurements/mutants-dashboards.txt.
//
//   VIZ_MUTANT_DIR=<scratch dir> node e2e/mutants-dashboards.cjs
//   VIZ_MUTANT_DIR=<scratch dir> ONLY=<part of a name> node e2e/mutants-dashboards.cjs   some, and no result file
//   PART=unit   only the unit run of every mutant (no browser)
//
// A mutant names the checks that must catch it: `unit` (vitest, the whole suite), sections of
// e2e/dashboards.cjs (the copy is then built and only those sections run), or `prod`.
// The properties: [key] the API key is in no URL and in no storage beyond sessionStorage's
// viz.key; [six] at most six requests in flight; [superseded] a superseded answer is not
// painted, and its requests are cancelled; [isolated] one panel's failure touches no other;
// [kind] a kind the app does not draw is not drawn as something else.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const SOURCE = path.resolve(__dirname, '..')
if (!process.env.VIZ_MUTANT_DIR) {
  console.error('VIZ_MUTANT_DIR is required: mutants are applied to a copy outside the shared tree')
  process.exit(2)
}
const ROOT = path.join(path.resolve(process.env.VIZ_MUTANT_DIR), 'app')
if (ROOT.startsWith(path.resolve(SOURCE, '..') + path.sep)) {
  console.error('VIZ_MUTANT_DIR is inside the repository: refusing')
  process.exit(2)
}
function makeCopy() {
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(ROOT, { recursive: true })
  for (const f of ['src', 'mock', 'e2e', 'public', 'scripts', 'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts', 'serve.json']) fs.cpSync(path.join(SOURCE, f), path.join(ROOT, f), { recursive: true })
  fs.symlinkSync(path.join(SOURCE, 'node_modules'), path.join(ROOT, 'node_modules'))
  for (const sibling of ['design-system', 'dashboard']) {
    const link = path.join(ROOT, '..', sibling)
    if (!fs.existsSync(link)) fs.symlinkSync(path.resolve(SOURCE, '..', sibling), link)
  }
}

// Each mutant: [name, checks, file, from, to]
const U = ['unit']
const LIST = [
  // ---- [key]
  ['[key] the key is sent in the address of the dashboards list', ['unit', 'key'], 'src/api/client.ts', "if (params.limit !== undefined) qs.set('limit', String(params.limit))", "if (params.limit !== undefined) qs.set('limit', String(params.limit))\n    qs.set('key', this.token)"],
  ['[key] the key is sent in the address of a dashboard', ['unit', 'key'], 'src/api/client.ts', '`/api/v1/control/dashboards/${encodeURIComponent(id)}`', '`/api/v1/control/dashboards/${encodeURIComponent(id)}?token=${this.token}`'],
  ['[key] the dashboard page keeps the client, key included, in sessionStorage', ['key'], 'src/dashboards/DashboardsPage.tsx', "  const doc = useQuery<DashboardDocument, Error>({", "  try {\n    sessionStorage.setItem('viz.dashboards.client', JSON.stringify(client))\n  } catch {}\n  const doc = useQuery<DashboardDocument, Error>({"],
  ['[key] "Open in Explore" carries the key in its address', ['key'], 'src/dashboards/PanelView.tsx', 'search={exploreSearch(q.expr, from, to)}', "search={{ ...exploreSearch(q.expr, from, to), unit: sessionStorage.getItem('viz.key') ?? 'auto' }}"],
  // ---- [six]
  ['[six] the limiter starts every request at once', ['unit', 'requests'], 'src/api/limiter.ts', 'if (this.running < this.max) start()', 'if (this.running < Infinity) start()'],
  ['[six] the limit is twelve', U, 'src/api/limiter.ts', 'export const MAX_IN_FLIGHT = 6', 'export const MAX_IN_FLIGHT = 12'],
  ['[six] a place that frees lets one too many start', U, 'src/api/limiter.ts', 'while (this.running < this.max && this.waiting.length > 0)', 'while (this.running <= this.max && this.waiting.length > 0)'],
  ['[six] the client sends its requests past the page\'s limiter (the dashboard\'s own limiter still holds its six)', U, 'src/api/client.ts', 'return REQUESTS.run(work, opts?.signal ?? NEVER)', 'return NEVER.aborted ? REQUESTS.run(work, NEVER) : work()'],
  ['[six] the dashboard has no limiter of its own (the client\'s still holds the page\'s six)', U, 'src/dashboards/store.ts', 'readonly limiter = new Limiter()', 'readonly limiter = new Limiter(64)'],
  // ---- [superseded]
  ['[superseded] an answer for an earlier range is delivered to the panel', ['unit', 'requests'], 'src/dashboards/scheduler.ts', 'if (generation !== this.generation || load.aborted) return', 'if (false as boolean) return'],
  ['[superseded] a new range does not cancel the requests of the one before', ['unit', 'requests'], 'src/dashboards/scheduler.ts', "    this.controller?.abort()\n    const controller = new AbortController()", '    const controller = new AbortController()'],
  ['[superseded] leaving the dashboard does not cancel its requests', ['unit', 'requests'], 'src/dashboards/store.ts', '    this.loader.cancel()\n', '    void this.loader\n'],
  ['[superseded] while a new range waits, the old answer is shown as if it were current', ['unit', 'requests'], 'src/dashboards/store.ts', 'const stale = old.result !== null && (old.stale || previous?.question !== question)', 'const stale = false && previous?.question !== question'],
  ['[superseded] the range in a dashboard\'s address is dropped when it is Explore\'s default', ['unit', 'requests'], 'src/lib/urlState.ts', 'const dashboard = str(search.id) !== undefined', 'const dashboard = false && str(search.id) !== undefined'],
  // ---- [isolated]
  ['[isolated] one panel\'s failure cancels the whole load', ['unit', 'panels'], 'src/dashboards/scheduler.ts', "      outcome = { status: 'error', error }", "      outcome = { status: 'error', error }\n      if (!load.aborted) this.controller?.abort()"],
  ['[isolated] one panel\'s failure takes the page down', ['panels'], 'src/dashboards/DashboardsPage.tsx', '  const loading = summary.waiting > 0', "  const loading = summary.waiting > 0\n  if (summary.failed > 0) throw new Error('a panel failed')"],
  ['[isolated] a failed panel shows nothing: no error, its place left empty', ['panels'], 'src/dashboards/PanelView.tsx', 'if (failed && !state.waiting) body = <PanelError', 'if (failed && !state.waiting && !failed) body = <PanelError'],
  ['[isolated] a failure is recorded on every panel', ['unit', 'panels'], 'src/dashboards/store.ts', "      this.set(id, { waiting: false, since: 0, result: old.result, stale: old.result !== null, error: halted ? null : outcome.error, halted })", "      for (const other of this.states.keys()) this.set(other, { waiting: false, since: 0, result: null, stale: false, error: halted ? null : outcome.error, halted })"],
  // ---- [kind]
  ['[kind] every kind counts as drawn: a heatmap gets an empty body and no word about it', ['unit', 'panels'], 'src/dashboards/model.ts', 'export const isDrawn = (kind: string): kind is DrawnKind => (DRAWN_KINDS as readonly string[]).includes(kind)', 'export const isDrawn = (kind: string): kind is DrawnKind => kind !== undefined'],
  ['[kind] a heatmap is drawn as a line chart', ['panels'], 'src/dashboards/PanelView.tsx', "else if (!drawn) body = <NotDrawn kind={panel.kind} text={text ?? ''} />", "else if (panel.kind === 'heatmap') body = <ChartBody id={id} result={result} panel={panel} />\n  else if (!drawn) body = <NotDrawn kind={panel.kind} text={text ?? ''} />"],
  ['[kind] a spec is drawn without the model\'s validation', ['unit', 'dashboard'], 'src/dashboards/model.ts', 'return v.ok ? { ok: true, spec: raw as Dashboard } : { ok: false, errors: v.errors }', 'return v.ok || raw ? { ok: true, spec: raw as Dashboard } : { ok: false, errors: v.errors }'],
  ['[kind] a panel that is not drawn does not say so', ['panels'], 'src/dashboards/PanelView.tsx', "This panel is a {KIND_WORDS[kind] ?? kind}, a kind this app does not draw yet. This is its text form.", 'Text form.'],
  // ---- what the gateway serves
  ['serve.json: /dashboards is not a document (a reload there would be a 404)', ['unit', 'prod'], 'serve.json', '"documents": ["/", "/explore", "/dashboards", "/help", "/settings"]', '"documents": ["/", "/explore", "/help", "/settings"]'],
]

const only = process.env.ONLY
const part = process.env.PART
// PART=unit: only the mutants a unit test is asked to catch.
const list = (only ? LIST.filter(([name]) => name.includes(only)) : LIST).filter(([, checks]) => part !== 'unit' || checks.includes('unit'))
const run = (cmd, args, env = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 })
const BASE = Number(process.env.VIZ_MUTANT_PORT || 18860)
const E2E_ENV = { VIZ_E2E_APP_PORT: String(BASE), VIZ_E2E_MOCK_PORT: String(BASE + 1), VIZ_PROD_PORT: String(BASE + 40) }

function checksOf(checks) {
  const failed = []
  const ran = []
  if (checks.includes('unit')) {
    ran.push('unit')
    const r = run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run'])
    for (const l of (r.stdout + r.stderr).split('\n')) { const x = /^\s*(?:×|✗)\s+(.+?)(?:\s+\d+ms)?$/.exec(l); if (x) failed.push(`unit: ${x[1].trim().slice(0, 120)}`) }
    if (r.status !== 0 && failed.length === 0) failed.push('unit: the run failed (a type or import error)')
  }
  const sections = part === 'unit' ? [] : checks.filter((c) => c !== 'unit' && c !== 'prod')
  const prod = part !== 'unit' && checks.includes('prod')
  if (sections.length || prod) {
    const b = run(process.execPath, ['node_modules/vite/bin/vite.js', 'build'])
    if (b.status !== 0) return { failed: [...failed, `build failed: ${(b.stderr || b.stdout).split('\n').find((l) => /error/i.test(l)) || ''}`.slice(0, 160)], ran }
  }
  if (sections.length) {
    ran.push(`e2e/dashboards.cjs (${sections.join(', ')})`)
    const r = run(process.execPath, ['e2e/dashboards.cjs'], { ...E2E_ENV, VIZ_ONLY: sections.join(',') })
    for (const l of r.stdout.split('\n')) if (l.startsWith('FAIL')) failed.push(`e2e: ${l.slice(6).split('  — ')[0].slice(0, 130)}`)
    if (r.status !== 0 && !r.stdout.includes('FAIL')) failed.push(`e2e: the run stopped (${(r.stderr.split('\n').find((l) => /Error|Timeout/.test(l)) || 'no output').slice(0, 100)})`)
  }
  if (prod) {
    ran.push('e2e/prod.cjs')
    const r = run(process.execPath, ['e2e/prod.cjs'], E2E_ENV)
    for (const l of r.stdout.split('\n')) if (l.startsWith('FAIL')) failed.push(`prod: ${l.slice(6).split('  — ')[0].slice(0, 130)}`)
    if (r.status !== 0 && !r.stdout.includes('FAIL')) failed.push('prod: the run stopped')
  }
  return { failed, ran }
}

makeCopy()
const lines = []
let survived = 0
for (const [name, checks, file, from, to] of list) {
  const p = path.join(ROOT, file)
  const src = fs.readFileSync(p, 'utf8')
  let line
  if (!src.includes(from)) line = `NOT APPLIED  ${name}  (the text to change was not found: the mutant is out of date)`
  else {
    fs.writeFileSync(p, src.replace(from, to))
    const { failed, ran } = checksOf(checks)
    fs.writeFileSync(p, src)
    const kinds = [...new Set(failed.map((f) => f.split(':')[0]))]
    if (failed.length === 0) survived++
    line = failed.length
      ? `KILLED    ${name}\n            checks run: ${ran.join('; ')}; caught by ${failed.length} (${kinds.join(' and ')}), e.g. ${failed.filter((f, i) => i < 2 || f.startsWith('e2e') || f.startsWith('prod')).slice(0, 4).join(' | ')}${ran.length > 1 ? `\n            ${ran.map((r) => `${r.split(' ')[0].replace('e2e/', '').replace('.cjs', '') === 'unit' ? 'unit' : r}: ${failed.some((f) => f.startsWith(r === 'unit' ? 'unit' : r.includes('prod') ? 'prod' : 'e2e')) ? 'caught it' : 'DID NOT catch it'}`).join('; ')}` : ''}`
      : `SURVIVED  ${name}\n            checks run: ${ran.join('; ')}; none failed`
  }
  console.log(line)
  lines.push(line)
}
const summary = `${lines.filter((l) => l.startsWith('KILLED')).length} of ${list.length} killed, ${survived} survived, ${lines.filter((l) => l.startsWith('NOT APPLIED')).length} not applied`
console.log('\n' + summary)
if (!only) fs.writeFileSync(path.join(SOURCE, 'e2e', 'measurements', `mutants-dashboards${part ? `-${part}` : ''}.txt`), `Mutants of the dashboards views (e2e/mutants-dashboards.cjs), applied to a copy in the session's scratch area.\n${new Date().toISOString()}\n\n${lines.join('\n')}\n\n${summary}\n`)
process.exit(survived ? 1 : 0)
