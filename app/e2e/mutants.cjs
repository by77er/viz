/* eslint-disable */
// "Tests must have teeth" (AGENTS.md, Evidence): break one property at a time in the source,
// rebuild, run the checks, and record which fail. A mutant that no check catches is reported
// as SURVIVED.
// Mutants are applied to a COPY of the app (AGENTS.md: never in place in the shared tree): the
// app's src, mock, e2e and config are copied to VIZ_MUTANT_DIR (default: a new directory under
// the system's temporary directory), node_modules and design-system are linked, every mutant
// is applied, built and checked there, and only the result file is written back to
// e2e/measurements/. The checkout itself is never written to.
//   VIZ_E2E_APP_PORT=... VIZ_E2E_MOCK_PORT=... node e2e/mutants.cjs                 the restyle's set: e2e/design.cjs
//   VIZ_E2E_APP_PORT=... VIZ_E2E_MOCK_PORT=... MUTANTS=fixes node e2e/mutants.cjs   the review fixes' set: unit tests and e2e/fixes.cjs
//   VIZ_E2E_APP_PORT=... VIZ_E2E_MOCK_PORT=... MUTANTS=real node e2e/mutants.cjs    the real-API change: the typed-array parser and
//                                                                                     the error states (unit tests and e2e/errors.cjs)
// ONLY=<substring of a name> runs one mutant and writes no file.
// The fixes set runs e2e/fixes.cjs without its 60 s stop case (VIZ_E2E_SKIP_STOP=1) to keep each run short.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const SOURCE = path.resolve(__dirname, '..')
/** The copy every mutant is applied to. */
const ROOT = path.join(process.env.VIZ_MUTANT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'viz-mutants-')), 'app')
function makeCopy() {
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(ROOT, { recursive: true })
  for (const f of ['src', 'mock', 'e2e', 'public', 'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts']) fs.cpSync(path.join(SOURCE, f), path.join(ROOT, f), { recursive: true })
  fs.symlinkSync(path.join(SOURCE, 'node_modules'), path.join(ROOT, 'node_modules'))
  const ds = path.join(ROOT, '..', 'design-system')
  if (!fs.existsSync(ds)) fs.symlinkSync(path.resolve(SOURCE, '../design-system'), ds)
}

// Each mutant: [name, [[file, from, to], ...]]
const one = (name, file, from, to) => [name, [[file, from, to]]]
const SETS = {
  design: {
    suites: ['design'],
    out: 'mutants.txt',
    list: [
      one('a second blue button (Save settings)', 'src/shell/SettingsPanel.tsx', '<button type="submit" className="vz-button">', '<button type="submit" className="vz-button" data-tone="blue">'),
      one('a literal colour in app CSS', 'src/app.css', '.cell-quiet { color: var(--ink-secondary); }', '.cell-quiet { color: #777777; }'),
      one('the second press is not ignored', 'src/explore/ExplorePage.tsx', 'if (loadingRef.current) return', 'if (false) return'),
      one('progress shown after 100 ms', 'src/explore/waiting.tsx', 'showAfter: 400,', 'showAfter: 100,'),
      one('progress not held for 300 ms', 'src/explore/waiting.tsx', 'minShown: 300,', 'minShown: 0,'),
      one('Cancel offered after 500 ms', 'src/explore/waiting.tsx', 'cancelAfter: 2000,', 'cancelAfter: 500,'),
      one('Cancel does not abort the request', 'src/explore/ExplorePage.tsx', 'void queryClient.cancelQueries({ queryKey: keyRef.current })', 'void 0'),
      one('rows of controls 4 px apart', 'src/app.css', '.toolbar-group { position: relative; display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-3) var(--space-2); }', '.toolbar-group { position: relative; display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-1) var(--space-2); }'),
      one('no focus ring on the query editor', 'src/app.css', '.query-well:focus-within { outline: var(--stroke) solid var(--focus); outline-offset: var(--stroke); }', ''),
      one('toolbar fields do not shrink or wrap (sideways scroll at 400 px)', 'src/app.css', '.toolbar .vz-field { max-width: 100%; }', '.toolbar .vz-field { flex: none; }'),
      one('the popover does not take focus', 'src/explore/TimeRangePicker.tsx', "(menuRef.current?.querySelector<HTMLElement>('[aria-current]') ?? items?.[0])?.focus()", 'void items'),
      one('legend rows stay 32 px with a coarse pointer', 'src/app.css', '  .legend-table td, .series-toggle { height: var(--control-touch); }', '  .legend-table td, .series-toggle { height: var(--row); }'),
    ],
  },
  // The fixes to the design review (design-system/reviews/app-restyle/review.md).
  fixes: {
    suites: ['unit', 'fixes'],
    out: 'mutants-fixes.txt',
    list: [
      one('B1: the unit comes from the pending query (the editor\'s text), not the result on screen', 'src/lib/describe.ts',
        "const unit: UnitId = display.unit !== 'auto' && isUnitId(display.unit) ? display.unit : result.inferredUnit",
        "const unit: UnitId = display.unit !== 'auto' && isUnitId(display.unit) ? display.unit : inferUnit(current.q)"),
      one('B1: the digest is titled with the pending query', 'src/lib/describe.ts', 'digestTitle: `Query: ${request.q}`,', 'digestTitle: `Query: ${current.q}`,'),
      one('B1: the chart is named after the pending query (in the page, past the derivation)', 'src/explore/ExplorePage.tsx',
        'ariaLabel={shown.chartLabel(aligned!.series.length)}',
        'ariaLabel={`Chart of ${aligned!.series.length} series for the query ${q}. Arrow keys move the cursor. The text form has the same data.`}'),
      one('B1: the head does not say "Showing the previous query"', 'src/lib/describe.ts',
        "staleText: stale === 'query' ? 'Showing the previous query' : stale === 'range' ? 'Showing the previous time range' : null,",
        'staleText: null,'),
      one('B3: typing re-renders the page (the draft is page state again)', null, null, null),
      one('B3: the deferred URL update leaves its guard set after a quick round trip (Back is then ignored)', 'src/explore/ExplorePage.tsx',
        'if (v === urlView.current) pushedView.current = null',
        'if (v === urlView.current) void 0'),
      one('B3: the focus keeper reads layout after every DOM change', 'src/lib/focusKeeper.ts',
        '  if (!watched.isConnected) return true\n  for (const r of records)',
        '  return true\n  for (const r of records)'),
      one('M3: focus is left on the body after Cancel (the keeper moves nothing)', 'src/lib/focusKeeper.ts', 'target.focus({ preventScroll: true })', 'void target'),
      one('M5: duplicate display names (shortening ignores collisions)', 'src/lib/naming.ts', 'if (!unique(candidate)) continue', 'if (false) continue'),
      one('M7: every cell repeats the unit', 'src/lib/units.ts',
        'cell: (v) => (v == null || !Number.isFinite(v) ? formatParts(v, unit).value : formatInScale(v, unit, scale, digits)),',
        'cell: (v) => formatValue(v, unit, digits),'),
      one('M2: a survivor is repainted (the previous assignment is ignored)', 'src/lib/assign.ts',
        'const slot = previous && Object.prototype.hasOwnProperty.call(previous, s.key) ? previous[s.key] : undefined',
        'const slot = undefined as number | undefined'),
      one('M2: a ninth coloured series', 'src/lib/assign.ts', 'export const SLOTS = 8', 'export const SLOTS = 9'),
      one('M2: every member of Other is its own legend row', 'src/explore/Legend.tsx', '{open && others.slice(0, limit).map(row)}', '{others.map(row)}'),
      one('M4: a tap on a legend row does nothing on touch', 'src/explore/Legend.tsx',
        '          onClick={(e) => {\n            // A tap does not focus',
        "          onClick={(e) => {\n            if ((e.nativeEvent as PointerEvent).pointerType === 'touch') return\n            // A tap does not focus"),
      one('M4: a tap isolates instead of toggling (a modifier is needed on touch)', 'src/lib/pointer.ts',
        "  if (e.pointerType === 'touch' || e.pointerType === 'pen') return true\n  return coarse && e.pointerType !== 'mouse'",
        '  return false'),
    ],
  },
  // The real-API change: the typed-array parser, and what a person sees when the API refuses or is busy.
  real: {
    suites: ['unit', 'errors'],
    out: 'mutants-real.txt',
    list: [
      one('parser: a number is scaled by multiplying by a power of ten below 1 (inexact)', 'src/api/matrix.ts',
        'const v = scale === 0 ? m : m / POW10[-scale]!', 'const v = scale === 0 ? m : m * Math.pow(10, scale)'),
      one('parser: digits past 2^53 are computed, not read by Number()', 'src/api/matrix.ts',
        'if (i !== to || !any || m >= EXACT || scale < -22) return Number(s.slice(from, to))', 'if (i !== to || !any || scale < -22) return Number(s.slice(from, to))'),
      one('parser: "+Inf" is read as NaN', 'src/api/matrix.ts', "if (s.startsWith('+Inf', from)) return Infinity", "if (s.startsWith('+Inf', from)) return NaN"),
      one('parser: a sample cut in two by the network loses its first character', 'src/api/matrix.ts',
        '            if (j >= n) return start\n            const t1 = j', '            if (j >= n) return start + 1\n            const t1 = j'),
      one('parser: an escaped quote in a label value ends the metric object early', 'src/api/matrix.ts',
        '        if (d === BACKSLASH) i++\n        else if (d === QUOTE) break', '        if (d === QUOTE) break'),
      one('parser: a time that is not a JSON number is accepted', 'src/api/matrix.ts',
        '    if (d >= 0 && d <= 9) return NaN\n  }', '    if (d >= 0 && d <= 9) return Number(s.slice(from, to))\n  }'),
      one('alignment: a gap is 0, not NaN', 'src/lib/series.ts', 'const values = new Float64Array(n).fill(NaN)', 'const values = new Float64Array(n)'),
      one('chart: a NaN gap reaches the renderer as a value (and is bridged)', 'src/lib/downsample.ts',
        'out[i] = v == null || v !== v ? null : v', 'out[i] = v'),
      one('statistics: a NaN gap counts as a value', 'src/lib/series.ts', 'if (v == null || v !== v) continue\n    if (v < min) min = v', 'if (v == null) continue\n    if (v < min) min = v'),
      one('errors: the API\'s time limit (503 timeout) is retried as if busy', 'src/api/errors.ts',
        "  if (errorType === 'timeout') return 'timeout'\n", ''),
      one('errors: Retry-After is ignored', 'src/api/errors.ts',
        '  if (error instanceof PromApiError && error.retryAfterMs !== null) return error.retryAfterMs\n', ''),
      one('errors: retries ignore the 60 s stop', 'src/api/errors.ts', '  return elapsedMs + retryDelayMs(error, failures) < budgetMs', '  return true'),
      one('errors: the waiting line does not say the API is busy', 'src/explore/ExplorePage.tsx',
        '{failures > 0 && query.failureReason', '{false && query.failureReason'),
      one('errors: a refused key is told to change the query', 'src/api/errors.ts',
        "      return 'The API did not accept the API key. Enter a valid key in Settings.'", '      return `Change the query and press ${mod} Enter to run it again.`'),
      one('errors: the button of a refused key runs the query again instead of opening Settings', 'src/explore/ExplorePage.tsx',
        "      ) : kind === 'auth' || kind === 'scope' ? (", "      ) : false ? ("),
      one('errors: Retry-After as an HTTP date is not read', 'src/api/client.ts',
        "  const at = /[A-Za-z]/.test(v) ? Date.parse(v) : NaN", '  const at = NaN'),
      one('warnings: the banner does not say the result may be incomplete', 'src/explore/ExplorePage.tsx', ', so it may be\n        incomplete: {warnings', ': {warnings'),
      one('autocomplete: lookups are not bounded by the page\'s time range', 'src/editor/promClient.ts',
        '    const w = lookupWindow(options.range?.())', '    const w = lookupWindow(null)'),
      // Added with the second pass against the real API (README, "Mock and real API").
      one('errors: a step too small for the range is advised as a change to the query', 'src/api/errors.ts',
        "  if (status === 400 && /^exceeded maximum resolution of \\d+ points/.test(message)) return 'resolution'\n", ''),
      one('errors: every limit is advised as "narrow the time range" (a 16 KiB query too)', 'src/api/errors.ts',
        '      return limitAdvice(limitName(error))', '      return limitAdvice(null)'),
      one('errors: a 401 with no key set says the key was refused', 'src/api/errors.ts',
        "      if (context.keySet === false) return 'No API key is set. Enter a key with the read scope in Settings.'\n", ''),
      one('errors: an answer that is not the API\'s is reported as "the API answered"', 'src/explore/ExplorePage.tsx',
        "{api.errorType !== 'network' && api.errorType !== 'http' && api.errorType !== 'parse' && api.status ? (", '{api.status ? ('),
      one('window: computed in fractional seconds (a 0.1 s step asks for another grid than the API evaluates)', 'src/lib/step.ts',
        '  const stepMs = Math.max(1, Math.round(step * 1000))\n  const startMs = Math.floor(Math.round(startSec * 1000) / stepMs) * stepMs\n  const endMs = Math.max(startMs + stepMs, Math.floor(Math.round(endSec * 1000) / stepMs) * stepMs)\n  return { start: startMs / 1000, end: endMs / 1000, step: stepMs / 1000 }',
        '  const start = Math.floor(startSec / step) * step\n  const end = Math.max(start + step, Math.floor(endSec / step) * step)\n  return { start, end, step }'),
      one('parser: the body text the JSON form reads is the first piece only (the lazy join)', 'src/api/matrix.ts',
        "return (this.joined ??= this.chunks.join(''))", "return (this.joined ??= this.chunks[0] ?? '')"),
      one('alignment: the grid tolerance is a fraction of a step (sub-second steps leave the grid)', 'src/lib/series.ts',
        '  const tolerance = 5e-6 / step\n', '  const tolerance = 1e-6\n'),
    ],
  },
}
// The page keeps the draft in state again, as before the fix: the editor reports every change.
SETS.fixes.list.find(([n]) => n.startsWith('B3: typing'))[1] = [
  ['src/editor/PromqlEditor.tsx', '          history(),\n',
    "          history(),\n          EditorView.updateListener.of((u) => { if (u.docChanged) window.dispatchEvent(new CustomEvent('viz-draft', { detail: u.state.doc.toString() })) }),\n"],
  ['src/explore/ExplorePage.tsx', '  const editorRef = useRef<PromqlEditorHandle | null>(null)\n',
    "  const editorRef = useRef<PromqlEditorHandle | null>(null)\n  const [, setDraft] = useState('')\n  useEffect(() => { const on = (e: Event) => setDraft((e as CustomEvent<string>).detail); window.addEventListener('viz-draft', on); return () => window.removeEventListener('viz-draft', on) }, [])\n"],
]

const SET = SETS[process.env.MUTANTS || 'design']
if (!SET) throw new Error(`MUTANTS: no set ${process.env.MUTANTS} (design, fixes or real)`)
makeCopy()
console.log(`mutants are applied to a copy: ${ROOT}`)

function runSuite(suite) {
  if (suite === 'unit') {
    const report = path.join(os.tmpdir(), `viz-app-mutant-${process.pid}.json`)
    spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=2', '--reporter=json', `--outputFile=${report}`], { cwd: ROOT, encoding: 'utf8' })
    let fails = []
    try {
      const r = JSON.parse(fs.readFileSync(report, 'utf8'))
      for (const f of r.testResults) {
        for (const a of f.assertionResults) if (a.status === 'failed') fails.push(`unit: ${a.fullName}`)
        if (f.status === 'failed' && f.assertionResults.length === 0) fails.push(`unit: ${path.basename(f.name)} did not load`)
      }
    } catch (e) { fails.push(`unit: no report (${e.message})`) }
    fs.rmSync(report, { force: true })
    return fails
  }
  const file = { fixes: 'e2e/fixes.cjs', errors: 'e2e/errors.cjs', design: 'e2e/design.cjs' }[suite]
  const run = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, VIZ_E2E_SKIP_STOP: '1' } })
  const fails = run.stdout.split('\n').filter((l) => l.startsWith('FAIL')).map((l) => `${suite === 'design' ? 'design' : 'e2e'}: ${l.slice(6).split('  — ')[0]}`)
  if (run.status !== 0 && fails.length === 0) fails.push(`${file} exited ${run.status}: ${(run.stderr || '').split('\n').filter(Boolean).slice(-1)[0] || ''}`)
  return fails
}

// DRY=1: only check that every mutant's source text is there, exactly once.
if (process.env.DRY) {
  let bad = 0
  for (const [name, edits] of SET.list) for (const [file, from] of edits) {
    const n = fs.readFileSync(path.join(ROOT, file), 'utf8').split(from).length - 1
    if (n !== 1) { bad++; console.log(`${n === 0 ? 'MISSING' : `${n} TIMES`}  ${name}  (${file})`) }
  }
  console.log(`${SET.list.length} mutants, ${bad} with a problem`)
  if (!process.env.VIZ_MUTANT_DIR) fs.rmSync(path.dirname(ROOT), { recursive: true, force: true })
  process.exit(bad ? 1 : 0)
}

const out = []
const only = process.env.ONLY // a substring of a mutant's name, to run just that one
for (const [name, edits] of SET.list) {
  if (only && !name.includes(only)) continue
  const originals = new Map()
  let applied = true
  for (const [file, from, to] of edits) {
    const p = path.join(ROOT, file)
    if (!originals.has(p)) originals.set(p, fs.readFileSync(p, 'utf8'))
    const now = fs.readFileSync(p, 'utf8')
    if (!now.includes(from)) { applied = false; break }
    fs.writeFileSync(p, now.replace(from, to))
  }
  try {
    if (!applied) { out.push(`NOT APPLIED  ${name}: source text not found`); continue }
    const needsBuild = SET.suites.some((s) => s !== 'unit')
    if (needsBuild) {
      const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { cwd: ROOT, encoding: 'utf8' })
      if (build.status !== 0) { out.push(`NOT BUILT    ${name}`); continue }
    }
    const fails = SET.suites.flatMap(runSuite)
    out.push(`${fails.length ? 'KILLED  ' : 'SURVIVED'}  ${name}${fails.length ? `\n            caught by: ${fails.join('; ')}` : ''}`)
  } finally {
    for (const [p, text] of originals) fs.writeFileSync(p, text)
  }
  console.log(out[out.length - 1])
}
fs.mkdirSync(path.join(SOURCE, 'e2e/measurements'), { recursive: true })
if (!only) fs.writeFileSync(path.join(SOURCE, 'e2e/measurements', SET.out), out.join('\n') + '\n')
// The copy is left for inspection only when asked for.
if (!process.env.VIZ_MUTANT_DIR) fs.rmSync(path.dirname(ROOT), { recursive: true, force: true })
