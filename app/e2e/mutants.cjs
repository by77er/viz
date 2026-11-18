/* eslint-disable */
// "Tests must have teeth" (AGENTS.md, Evidence): break one property at a time in the source,
// rebuild, run the checks, and record which fail. The source is restored after every mutant.
// A mutant that no check catches is reported as SURVIVED.
//   VIZ_E2E_APP_PORT=... VIZ_E2E_MOCK_PORT=... node e2e/mutants.cjs                 the restyle's set: e2e/design.cjs
//   VIZ_E2E_APP_PORT=... VIZ_E2E_MOCK_PORT=... MUTANTS=fixes node e2e/mutants.cjs   the review fixes' set: unit tests and e2e/fixes.cjs
// ONLY=<substring of a name> runs one mutant and writes no file.
// The fixes set runs e2e/fixes.cjs without its 60 s stop case (VIZ_E2E_SKIP_STOP=1) to keep each run short.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const ROOT = path.resolve(__dirname, '..')

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
}
// The page keeps the draft in state again, as before the fix: the editor reports every change.
SETS.fixes.list.find(([n]) => n.startsWith('B3: typing'))[1] = [
  ['src/editor/PromqlEditor.tsx', '          history(),\n',
    "          history(),\n          EditorView.updateListener.of((u) => { if (u.docChanged) window.dispatchEvent(new CustomEvent('viz-draft', { detail: u.state.doc.toString() })) }),\n"],
  ['src/explore/ExplorePage.tsx', '  const editorRef = useRef<PromqlEditorHandle | null>(null)\n',
    "  const editorRef = useRef<PromqlEditorHandle | null>(null)\n  const [, setDraft] = useState('')\n  useEffect(() => { const on = (e: Event) => setDraft((e as CustomEvent<string>).detail); window.addEventListener('viz-draft', on); return () => window.removeEventListener('viz-draft', on) }, [])\n"],
]

const SET = SETS[process.env.MUTANTS || 'design']
if (!SET) throw new Error(`MUTANTS: no set ${process.env.MUTANTS} (design or fixes)`)

function runSuite(suite) {
  if (suite === 'unit') {
    const report = path.join(os.tmpdir(), `viz-app-mutant-${process.pid}.json`)
    spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--reporter=json', `--outputFile=${report}`], { cwd: ROOT, encoding: 'utf8' })
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
  const file = suite === 'fixes' ? 'e2e/fixes.cjs' : 'e2e/design.cjs'
  const run = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, VIZ_E2E_SKIP_STOP: '1' } })
  const fails = run.stdout.split('\n').filter((l) => l.startsWith('FAIL')).map((l) => `${suite === 'fixes' ? 'e2e' : 'design'}: ${l.slice(6).split('  — ')[0]}`)
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
spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { cwd: ROOT })
fs.mkdirSync(path.join(ROOT, 'e2e/measurements'), { recursive: true })
if (!only) fs.writeFileSync(path.join(ROOT, 'e2e/measurements', SET.out), out.join('\n') + '\n')
