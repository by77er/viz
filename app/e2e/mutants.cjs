/* eslint-disable */
// "Tests must have teeth" (AGENTS.md, Evidence): break one property at a time in the source,
// run the checks, and record which fail. A mutant that no check catches is reported as
// SURVIVED.
//
// Mutants are applied to a COPY of the app, never in place in the shared tree: the app's
// source, mock, e2e and configuration are copied to VIZ_MUTANT_DIR (which must be given: a
// directory in the session's scratch area), node_modules and design-system are linked, every
// mutant is applied, checked and undone there, and only the result file is written back to
// e2e/measurements/mutants-v9.txt.
//
//   VIZ_MUTANT_DIR=<scratch dir> node e2e/mutants.cjs            every mutant of the move to design system v9
//   VIZ_MUTANT_DIR=<scratch dir> ONLY=<part of a name> node e2e/mutants.cjs   some, and no result file
//   PART=unit | PART=e2e   the mutants that only unit tests are asked to catch, or the others; results in mutants-v9-<part>.txt
//
// A mutant names the checks that must catch it: `unit` (vitest, the whole suite) or sections
// of e2e/app.cjs (the copy is then built and only those sections run), or `prod` (e2e/prod.cjs).
// Earlier sets (the restyle, the review fixes, the real API) broke code that this change
// replaced; their results stay in e2e/measurements/mutants{,-fixes,-real}.txt.
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
  // What the app imports from beside itself: the design system's build and the dashboard model's source.
  for (const sibling of ['design-system', 'dashboard']) {
    const link = path.join(ROOT, '..', sibling)
    if (!fs.existsSync(link)) fs.symlinkSync(path.resolve(SOURCE, '..', sibling), link)
  }
}

// Each mutant: [name, checks, [[file, from, to], ...]]
const m = (name, checks, file, from, to) => [name, checks, [[file, from, to]]]
const U = ['unit']
const LIST = [
  // ---- who gets in (shell/session.tsx)
  m('session: a 401 for a tab with no key is reported as a refused key', U, 'src/shell/session.tsx', "return { status: 'out', reason: hasKey ? 'refused' : 'none' }", "return { status: 'out', reason: 'refused' }"),
  m('session: when the API does not answer, a tab without a key is let in', U, 'src/shell/session.tsx', "return hasKey ? { status: 'in', identity: null, unchecked: 'no-answer' } : { status: 'out', reason: 'no-answer', detail: message }", "return { status: 'in', identity: null, unchecked: 'no-answer' }"),
  m('session: an API without a control plane (404) shows the sign-in form', U, 'src/shell/session.tsx', "if (status === 404) return { status: 'in', identity: null, unchecked: 'no-control' }", ''),
  m('sign-in: a key without the read scope is accepted', U, 'src/shell/session.tsx', 'if (outcome.identity.scopes.includes(READ_SCOPE)) return { ok: true }', 'if (outcome.identity.scopes.length >= 0) return { ok: true }'),
  m('sign-in: the admin scope counts as read', U, 'src/shell/session.tsx', 'if (outcome.identity.scopes.includes(READ_SCOPE)) return { ok: true }', "if (outcome.identity.scopes.includes(READ_SCOPE) || outcome.identity.scopes.includes('admin')) return { ok: true }"),
  m('sign-in: a refused key is reported as "could not be checked"', U, 'src/shell/session.tsx', "if (status === 401 || status === 403) {\n    return { ok: false, where: 'field',", "if (status === 401 || status === 403) {\n    return { ok: false, where: 'notice',"),
  m('sign-in: the key\'s whole text is shown as its label', U, 'src/shell/session.tsx', "return m ? `${m[1]}_…` : ''", 'return key'),
  m('whoami: the key is sent in the address', U, 'src/api/client.ts', "const res = await this.send('/api/v1/control/whoami', { method: 'GET' }, opts)", "const res = await this.send('/api/v1/control/whoami?key=' + this.token, { method: 'GET' }, opts)"),
  m('whoami: any 200 is trusted as an identity', U, 'src/api/client.ts', "if (!v || typeof v.tenant !== 'string' || !Array.isArray(v.scopes)) throw new PromApiError('parse', 'The answer is not an identity', res.status)", "if (!v) throw new PromApiError('parse', 'The answer is not an identity', res.status)\n    v.tenant ??= ''\n    v.scopes ??= ['read']"),
  m('mock whoami: a key without the read scope is not told who it is', U, 'mock/handler.ts', "if (opts.readlessToken && token === opts.readlessToken) return identity('write-only key', ['write'])", ''),
  // ---- sign-in on the page
  m('sign-in: the key is kept in localStorage', ['signin'], 'src/shell/session.tsx', "if (key) sessionStorage.setItem(KEY_STORE, key)", "if (key) { sessionStorage.setItem(KEY_STORE, key); localStorage.setItem(KEY_STORE, key) }"),
  ['sign-in: the key field has a name and the form is a GET', ['signin'], [['src/shell/SignIn.tsx', 'method="post"', 'method="get"'], ['src/shell/SignIn.tsx', 'data-mono=""\n              type={show', 'data-mono=""\n              name="key"\n              type={show']]],
  m('sign-in: the token an earlier version left in localStorage stays', ['signin'], 'src/shell/session.tsx', 'localStorage.removeItem(LEGACY_STORE)', 'void LEGACY_STORE'),
  m('sign-in: Explore is shown without a key', ['signin'], 'src/shell/AppShell.tsx', "if (session.status === 'out') return <SignIn reason={session.reason} detail={session.detail} />", "if (session.status === 'out') return <>{children}</>"),
  m('sign-in: a refused key stays in the tab', ['signin'], 'src/shell/session.tsx', "      if (next.status === 'out' && hasKey) {\n        writeKey('')", "      if (next.status === 'out' && hasKey) {\n        void writeKey"),
  m('sign-in: Sign out leaves the key in the tab', ['signin'], 'src/shell/session.tsx', "  const signOut = useCallback((reason: 'left' | 'refused' = 'left') => {\n    writeKey('')", "  const signOut = useCallback((reason: 'left' | 'refused' = 'left') => {\n    void writeKey"),
  // ---- times as typed and read (lib/timeInput.ts)
  m('time: "now - 6 h" loses its unit (hours read as minutes)', U, 'src/lib/timeInput.ts', 'h: 3600, d: 86400', 'h: 60, d: 86400'),
  m('time: a day without a year is always this year', U, 'src/lib/timeInput.ts', 'if (dm[3] === undefined && msOf({ y, mo, d, ...c }, zone) > nowMs + 86_400_000 && realDay(y - 1, mo, d)) y -= 1', ''),
  m('time: a field shows a day without its year even when it is not this year\'s', U, 'src/lib/timeInput.ts', 'return `${dayText(w, sameYear ? w.y : NaN)} ${clockText(w)}`', 'return `${dayText(w, w.y)} ${clockText(w)}`'),
  m('time: a clock time is read in UTC whatever the zone', U, 'src/lib/timeInput.ts', 'const first = asUtc - zoneShiftMs(zone, asUtc)\n  return asUtc - zoneShiftMs(zone, first)', 'return asUtc'),
  m('time: 24:30 is read as a time', U, 'src/lib/timeInput.ts', 'return h < 24 && mi < 60 && s < 60 ? { h, mi, s } : null', 'return h < 25 && mi < 60 && s < 60 ? { h, mi, s } : null'),
  m('time: 31 Feb is read as a day', U, 'src/lib/timeInput.ts', 'if (!realDay(y, mo, d)) return null', ''),
  m('time: the zone is not stated', U, 'src/lib/timeInput.ts', 'return { text: `${text}, ${zoneName(zone, endSec * 1000)}`, startSec, endSec }', 'return { text, startSec, endSec }'),
  m('time: a preset is chosen only when spelt the same ("24 h" is not "1 d")', U, 'src/explore/TimeRangeField.tsx', "return a.startsWith('now-') && b.startsWith('now-') && parseDuration(a.slice(4)) === parseDuration(b.slice(4))", 'return false'),
  m('time: the chart reads UTC in every zone (no shift)', ['zone'], 'src/explore/ExplorePage.tsx', 'const shiftMs = useMemo(() => (result ? zoneShiftMs(LOCAL, result.window.end * 1000) : 0), [result])', 'const shiftMs = useMemo(() => (result ? 0 * zoneShiftMs(LOCAL, result.window.end * 1000) : 0), [result])'),
  // ---- the result as the chart takes it (charts/spec.ts, fixups.ts)
  m('chart: a gap is 0, not a break in the line', ['unit', 'chart'], 'src/charts/spec.ts', 'values[i] = Number.isFinite(v) ? v * u.scale : null', 'values[i] = Number.isFinite(v) ? v * u.scale : 0'),
  m('chart: times are not moved to the zone', U, 'src/charts/spec.ts', 't0: Math.round(start * 1000) + shiftMs', 't0: Math.round(start * 1000)'),
  m('chart: a ratio is drawn as a fraction under a % sign', U, 'src/charts/spec.ts', "return { name: '%', scale: 100 }", "return { name: '%', scale: 1 }"),
  m('chart: bytes per second in decimal steps', U, 'src/charts/spec.ts', 'while (i < BYTE_RATES.length - 1 && maxAbs >= 1024 ** (i + 1)) i++', 'while (i < BYTE_RATES.length - 1 && maxAbs >= 1000 ** (i + 1)) i++'),
  m('chart: a series with no labels has no name', ['unit', 'chart'], 'src/charts/spec.ts', 'return { query }', 'return labels'),
  m('table: figures in the raw unit, not the chart\'s', U, 'src/charts/spec.ts', 'const fmt = rules.numberFormat(ax.step, scaled.suffix, scaled.div)', 'const fmt = rules.numberFormat(ax.step, scaled.suffix, 1)'),
  m('text form: the step stays "every 0.25 min, instant"', ['unit', 'flow'], 'src/charts/fixups.ts', '`, one value every ${step}.`', "'$&'"),
  m('chart: a result with no unit keeps "Last, "', ['chart'], 'src/charts/fixups.ts', "export const fixHead = (text: string) => (text.endsWith(', ') ? text.slice(0, -2) : text)", 'export const fixHead = (text: string) => text'),
  m('legend: a row is named by its label set only, not the words it shows', ['unit', 'axe'], 'src/charts/fixups.ts', 'return `${words}: ${name}`', 'return name'),
  // ---- old data keeps its own labels (B1), and the chart's states
  m('B1: the panel names the query that is waiting, not the one drawn', ['b1'], 'src/lib/describe.ts', 'q: request.q,', 'q: current.q,'),
  m('B1: the head does not say "Showing the previous query"', ['unit', 'b1'], 'src/lib/describe.ts', "staleText: stale === 'query' ? 'Showing the previous query'", "staleText: stale === 'query' ? null"),
  m('B1: after an error nothing of the result that was drawn is kept', ['b1'], 'src/explore/ExplorePage.tsx', '(query.data ?? (query.isError ? lastResult.current : undefined))', '(query.data ?? undefined)'),
  m('B1: the chart is not told of the error (the plot stays as if current)', ['b1'], 'src/explore/ExplorePage.tsx', "error={view === 'chart' ? chartError : null}", 'error={null}'),
  m('nothing reserved for the query line: the chart moves when a result lands', ['shift'], 'src/explore/ExplorePage.tsx', '<p className="vz-panel-desc result-query is-reserved" aria-hidden="true">\n              <span className="vz-qty">{\'\\u00a0\'}</span>\n            </p>', '<></>'),
  m('the chart\'s height is not remembered for the next load', ['shift'], 'src/charts/Chart.tsx', "sessionStorage.setItem(RESERVE + view, JSON.stringify({ rows, notes }))", 'void rows'),
  m('"Query the chart\'s range" is always offered', ['zoom'], 'src/explore/TimeRangeField.tsx', "className={shown ? 'vz-button' : 'vz-button is-reserved'}", "className=\"vz-button\""),
  m('a zoom on the chart is not noticed', ['zoom'], 'src/charts/Chart.tsx', 'live.current.onShownRange?.(zoomed ? { fromMs: h.state.t0 - shift, toMs: h.state.t1 - shift } : null)', 'void shift'),
  m('the table\'s caption says "highest value first" whatever the order', U, 'src/explore/ResultTable.tsx', "if (sort.key === VALUE) return sort.dir === -1 ? 'highest value first' : 'lowest value first'", "if (sort.key === VALUE) return 'highest value first'"),
  m('the table puts series with no value first', U, 'src/explore/ResultTable.tsx', 'if (a.last == null) return b.last == null ? 0 : 1\n      if (b.last == null) return -1', 'if (a.last == null) return b.last == null ? 0 : -1\n      if (b.last == null) return 1'),
  // ---- waiting, touch, keyboard
  m('the waiting line is shown after 100 ms', ['waiting'], 'src/explore/waiting.tsx', 'showAfter: 400,', 'showAfter: 100,'),
  m('the waiting line is not held for 300 ms', ['waiting'], 'src/explore/waiting.tsx', 'minShown: 300,', 'minShown: 0,'),
  m('a second press while the query runs sends it again', ['waiting'], 'src/explore/ExplorePage.tsx', 'if (loadingRef.current) return', 'if (false) return'),
  m('Cancel does not abort the request', ['waiting'], 'src/explore/ExplorePage.tsx', 'void queryClient.cancelQueries({ queryKey: keyRef.current })', 'void 0'),
  m('B2: the editor keeps its own type size in the touch-height well', ['touch'], 'src/editor/PromqlEditor.tsx', "'.cm-content': { padding: '0', caretColor: 'var(--ink)', font: 'inherit' },", "'.cm-content': { padding: '0', caretColor: 'var(--ink)', font: 'var(--text-code)' },"),
  m('a literal colour in the app\'s CSS', ['colour'], 'src/app.css', '.palette-none { padding: var(--space-2); color: var(--ink-secondary); }', '.palette-none { padding: var(--space-2); color: var(--ink-secondary); }\n.vz-page-title { color: #333333; }'),
  m('a second blue button in Explore (Show earlier)', ['colour'], 'src/explore/TimeRangeField.tsx', '<button className="vz-button" data-size="sm" onClick={() => shift(-1)}', '<button className="vz-button" data-size="sm" data-tone="blue" onClick={() => shift(-1)}'),
  m('no focus ring on the query editor', ['keyboard'], 'src/app.css', '.query-well:focus-within { outline: var(--stroke) solid var(--focus); outline-offset: var(--stroke); }', ''),
  m('the palette\'s field has no visible label', ['keyboard'], 'src/shell/CommandPalette.tsx', '<span className="vz-label">Command</span>', '<span className="vz-label vz-sr">Command</span>'),
  m('a page in which something throws is left empty', ['flow'], 'src/shell/ErrorBoundary.tsx', 'if (!error) return this.props.children\n    return (', 'if (!error) return this.props.children\n    if (error) return null\n    return ('),
  m('an empty page box stands while the API is asked who the key is (the banner then moves it)', ['shift'], 'src/shell/AppShell.tsx', 'if (!wait.shown) return null', 'if (!wait.shown) return <div className="vz-page" />'),
  m('the address is written with the router\'s default: the page goes to the top after a change of form', ['shift'], 'src/explore/ExplorePage.tsx', 'replace, resetScroll: false }),', 'replace }),'),
  m('the table prepared for an earlier result is shown for a later one', ['flow'], 'src/explore/ExplorePage.tsx', 'if (have && have.aligned === a && have.chart === c) return have.table', 'if (have) return have.table'),
  // ---- what the gateway serves
  m('serve.json: /settings is not a document (a reload there would be a 404)', U, 'serve.json', '"documents": ["/", "/explore", "/dashboards", "/help", "/settings"]', '"documents": ["/", "/explore", "/dashboards", "/help"]'),
  m('serve.json: the policy allows inline scripts', U, 'serve.json', "script-src 'self';", "script-src 'self' 'unsafe-inline';"),
  m('the theme is applied by an inline script', ['prod'], 'vite.config.ts', "return [{ tag: 'script', attrs: { src }, injectTo: 'head-prepend' }]", "return [{ tag: 'script', children: readFileSync(file, 'utf8'), injectTo: 'head-prepend' }]"),
]

const only = process.env.ONLY
// PART=unit: the mutants only the unit tests are asked to catch (no browser); PART=e2e: the rest. Each part writes its own file.
const part = process.env.PART
const unitOnly = ([, checks]) => checks.length === 1 && checks[0] === 'unit'
const list = (only ? LIST.filter(([name]) => name.includes(only)) : LIST).filter((x) => (part === 'unit' ? unitOnly(x) : part === 'e2e' ? !unitOnly(x) : true))
const run = (cmd, args, env = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 })
const BASE = Number(process.env.VIZ_MUTANT_PORT || 18860)
const E2E_ENV = { VIZ_E2E_APP_PORT: String(BASE), VIZ_E2E_MOCK_PORT: String(BASE + 1), VIZ_PROD_PORT: String(BASE + 40) }

function checksOf(checks) {
  const failed = []
  if (checks.includes('unit')) {
    const r = run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run'])
    for (const l of (r.stdout + r.stderr).split('\n')) { const x = /^\s*(?:×|✗|FAIL)\s+(.+?)(?:\s+\d+ms)?$/.exec(l); if (x && !/^src\/|^mock\//.test(x[1])) failed.push(`unit: ${x[1].trim().slice(0, 110)}`) }
    if (r.status !== 0 && failed.length === 0) failed.push('unit: the run failed (a type or import error)')
  }
  const sections = checks.filter((c) => c !== 'unit' && c !== 'prod')
  if (sections.length || checks.includes('prod')) {
    const b = run(process.execPath, ['node_modules/vite/bin/vite.js', 'build'])
    if (b.status !== 0) return [...failed, `build failed: ${(b.stderr || b.stdout).split('\n').find((l) => /error/i.test(l)) || ''}`.slice(0, 160)]
  }
  if (sections.length) {
    const r = run(process.execPath, ['e2e/app.cjs'], { ...E2E_ENV, VIZ_ONLY: sections.join(',') })
    for (const l of r.stdout.split('\n')) if (l.startsWith('FAIL')) failed.push(`e2e: ${l.slice(6).split('  — ')[0].slice(0, 120)}`)
    if (r.status !== 0 && !r.stdout.includes('FAIL')) failed.push(`e2e: the run stopped (${(r.stderr.split('\n').find((l) => /Error|Timeout/.test(l)) || 'no output').slice(0, 100)})`)
  }
  if (checks.includes('prod')) {
    const r = run(process.execPath, ['e2e/prod.cjs'], E2E_ENV)
    for (const l of r.stdout.split('\n')) if (l.startsWith('FAIL')) failed.push(`prod: ${l.slice(6).split('  — ')[0].slice(0, 120)}`)
    if (r.status !== 0 && !r.stdout.includes('FAIL')) failed.push('prod: the run stopped')
  }
  return failed
}

makeCopy()
const lines = []
let survived = 0
for (const [name, checks, edits] of list) {
  const saved = new Map()
  let applied = true
  for (const [file, from, to] of edits) {
    const p = path.join(ROOT, file)
    const src = saved.get(p) ?? fs.readFileSync(p, 'utf8')
    if (!saved.has(p)) saved.set(p, src)
    const cur = fs.readFileSync(p, 'utf8')
    if (!cur.includes(from)) { applied = false; break }
    fs.writeFileSync(p, cur.replace(from, to))
  }
  let line
  if (!applied) line = `NOT APPLIED  ${name}  (the text to change was not found: the mutant is out of date)`
  else {
    const failed = checksOf(checks)
    if (failed.length === 0) survived++
    line = failed.length ? `KILLED    ${name}\n            checks run: ${checks.join(', ')}; caught by ${failed.length}: ${failed.slice(0, 4).join(' | ')}` : `SURVIVED  ${name}\n            checks run: ${checks.join(', ')}; none failed`
  }
  for (const [p, src] of saved) fs.writeFileSync(p, src)
  console.log(line)
  lines.push(line)
}
const summary = `${lines.filter((l) => l.startsWith('KILLED')).length} of ${list.length} killed, ${survived} survived, ${lines.filter((l) => l.startsWith('NOT APPLIED')).length} not applied`
console.log('\n' + summary)
if (!only) fs.writeFileSync(path.join(SOURCE, 'e2e', 'measurements', `mutants-v9${part ? `-${part}` : ''}.txt`), `Mutants of the move to design system v9 (e2e/mutants.cjs), applied to a copy in the session's scratch area.\n${new Date().toISOString()}\n\n${lines.join('\n')}\n\n${summary}\n`)
process.exit(survived ? 1 : 0)
