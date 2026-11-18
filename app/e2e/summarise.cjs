/* eslint-disable */
// Prints the before/after speed table from e2e/measurements/<before>-<n>.json and <after>-<n>.json.
//   node e2e/summarise.cjs [--before fixes-before] [--after fixes-after] [--series 4,36,200]
// Each cell is the 75th percentile, then (median, maximum), over the runs in the file.
const path = require('node:path')
const fs = require('node:fs')
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback }
const BEFORE = arg('before', 'fixes-before')
const AFTER = arg('after', 'fixes-after')
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
  ['picker', 'Open the time picker', 100],
  ['response', 'Response to paint, after the body is parsed (the harness\'s original figure)', 100],
  ['responseFull', 'Response to paint, from the last byte (includes reading and parsing the body)', 100],
  ['inp', 'Worst interaction, Event Timing, before typing and crosshair', 200],
  ['inpAll', 'Worst interaction, Event Timing, the whole run', 200],
  ['clsLoad', 'Layout shift, first load', 0.05],
  ['clsRun', 'Layout shift, query run', 0.05],
]
const fmt = (k, v) => (v == null ? '–' : k.startsWith('cls') ? v.toFixed(4) : k === 'typingOver' ? v.toFixed(0) : `${Math.round(v)}`)
const cell = (k, s) => (s ? `${fmt(k, s.p75)} (${fmt(k, s.median)}, ${fmt(k, s.max)})` : 'not measured')
const unit = (k) => (k.startsWith('cls') || k === 'typingOver' ? '' : ' ms')
for (const n of CASES) {
  const b = load(BEFORE, n)
  const a = load(AFTER, n)
  if (!b && !a) continue
  console.log(`\n### ${n} series (${(a || b).query})\n`)
  console.log(`Runs: before ${b ? b.runs : 0}, after ${a ? a.runs : 0}.\n`)
  console.log('| What | Budget | Before | After | Within budget after? |')
  console.log('|---|---|---|---|---|')
  for (const [k, label, budget] of ROWS) {
    const bs = b && b.summary[k]
    const as = a && a.summary[k]
    if (!bs && !as) continue
    const ok = budget == null || !as ? '' : as.p75 <= budget ? 'yes' : `**no**, ${fmt(k, as.p75)}${unit(k)}`
    console.log(`| ${label} | ${budget == null ? '' : `${budget}${unit(k)}`} | ${cell(k, bs)} | ${cell(k, as)} | ${ok} |`)
  }
}
