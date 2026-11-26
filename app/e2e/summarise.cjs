/* eslint-disable */
// Prints speed tables from e2e/measurements/<label>-<n>.json, one column per label.
//   node e2e/summarise.cjs [--before fixes-before] [--after fixes-after] [--series 4,36,200]
//   node e2e/summarise.cjs --labels cand-A,cand-B,cand-C,cand-W --names A,B,C,W --series 36,200
// Each cell is the 75th percentile, then (median, maximum), over the runs in the file. Under
// each table: the load average at the start of the runs (median, range), the core count, how
// many runs were judged (load at most the core count; design-system README, "Load") and the
// calibration task's time. When most runs were not judged, the budget column says so instead
// of yes or no ("not judged" rows are printed, not judged).
const path = require('node:path')
const fs = require('node:fs')
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback }
const LABELS = arg('labels', `${arg('before', 'fixes-before')},${arg('after', 'fixes-after')}`).split(',')
const NAMES = arg('names', LABELS.length === 2 && !process.argv.includes('--labels') ? 'Before,After' : LABELS.join(',')).split(',')
const CASES = arg('series', '4,36,200').split(',')
const dir = path.join(__dirname, 'measurements')
const load = (label, n) => { const f = path.join(dir, `${label}-${n}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null }

const ROWS = [
  ['press', 'Press on Run query: pointerdown to the pressed frame', 50],
  ['busy', 'Click on Run query to the busy state painted', 100],
  ['typing', 'Typing: keydown to the next frame, 75th percentile of the 60 keys of a run', 50],
  ['typingWorst', 'Typing: the slowest key of a run (not a budget figure)', null],
  ['typingOver', 'Typing: keys over 50 ms, of 60', null],
  ['crosshair', 'Crosshair: pointer move to the next frame', 50],
  ['chartToTable', 'Chart to table', 100],
  ['tableToText', 'Table to text', 100],
  ['textToChart', 'Text to chart', 100],
  ['legendToggle', 'Legend row chosen: release to the chosen row painted', 100],
  ['picker', 'Open the time picker (a menu; the app on v9 has none in this view)', 100],
  ['response', 'Response to paint, after the harness\'s copy of the body resolved (or the worker\'s message)', 100],
  ['responseFull', 'Response to paint, from the last byte (includes reading and parsing the body)', 100],
  ['runToPaint', 'Release of Run query to the result painted, network included (not a budget figure)', null],
  ['inp', 'Worst interaction, Event Timing, before typing and crosshair', 200],
  ['inpAll', 'Worst interaction, Event Timing, the whole run', 200],
  ['clsLoad', 'Layout shift, first load', 0.05],
  ['clsRun', 'Layout shift, query run', 0.05],
]
const fmt = (k, v) => (v == null ? '–' : k.startsWith('cls') ? v.toFixed(4) : k === 'typingOver' ? v.toFixed(0) : `${Math.round(v)}`)
const cell = (k, s) => (s ? `${fmt(k, s.p75)} (${fmt(k, s.median)}, ${fmt(k, s.max)})` : 'not measured')
const unit = (k) => (k.startsWith('cls') || k === 'typingOver' ? '' : ' ms')
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] }
const loadLine = (name, f) => {
  const l = f.raw.map((r) => r.load1)
  const cores = f.cores ?? f.summary.judgedRuns?.cores ?? 4
  const judged = l.filter((x) => x <= cores).length
  const cal = f.calibrationsMs?.length ? `, calibration ${Math.round(q(f.calibrationsMs, 0.5))} ms (median of ${f.calibrationsMs.length} batch${f.calibrationsMs.length === 1 ? '' : 'es'})` : ''
  return `${name}: ${f.runs} runs, load at run start median ${q(l, 0.5).toFixed(1)} (${Math.min(...l).toFixed(1)} to ${Math.max(...l).toFixed(1)}) on ${cores} cores, ${judged} of ${f.runs} runs judged${cal}`
}
for (const n of CASES) {
  const files = LABELS.map((l) => load(l, n))
  if (files.every((f) => !f)) continue
  const any = files.find(Boolean)
  console.log(`\n### ${n} series (${any.query}), ${any.layout ?? 'desktop'}\n`)
  const last = files[files.length - 1]
  const lastJudged = last ? last.raw.filter((r) => r.load1 <= (last.cores ?? 4)).length : 0
  const judgedAll = last && lastJudged * 2 >= last.runs
  console.log(`| What | Budget | ${NAMES.join(' | ')} | Within budget (${NAMES[NAMES.length - 1]})? |`)
  console.log(`|---|---|${NAMES.map(() => '---|').join('')}---|`)
  for (const [k, label, budget] of ROWS) {
    const ss = files.map((f) => f && f.summary[k])
    if (ss.every((s) => !s)) continue
    const as = ss[ss.length - 1]
    let ok = ''
    if (budget != null && as) {
      const within = as.p75 <= budget
      ok = k.startsWith('cls') || judgedAll ? (within ? 'yes' : `**no**, ${fmt(k, as.p75)}${unit(k)}`) : `${within ? 'within' : 'over'}, not judged (load > cores)`
    }
    console.log(`| ${label} | ${budget == null ? '' : `${budget}${unit(k)}`} | ${ss.map((s) => cell(k, s)).join(' | ')} | ${ok} |`)
  }
  console.log('')
  files.forEach((f, i) => f && console.log(`- ${loadLine(NAMES[i], f)}`))
}
