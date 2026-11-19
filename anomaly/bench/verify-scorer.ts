/**
 * Check that bench/nab.ts scores like NAB: run NAB's own published detector outputs through
 * it with NAB's protocol (threshold optimised per profile over the whole corpus, scores
 * normalised by the null detector and the window count) and compare with the repository's
 * results/final_results.json.
 *
 *   node --experimental-strip-types bench/verify-scorer.ts
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import {
  loadCorpus, loadProfiles, loadPublishedScores, publishedFinalResults, sweepRows,
  optimizeThreshold, scoreAt, normalize, PROFILE_NAMES, NAB_DIR,
} from './nab.ts'

const files = loadCorpus()
const profiles = loadProfiles()
const published = publishedFinalResults()
const rows = files.map((f) => sweepRows(f)) // not map(sweepRows): the index would become the probation length
const nWindows = files.reduce((a, f) => a + f.windows.length, 0)

// Null baseline exactly as NAB computes it: the null detector's outputs, optimised and scored.
const nullEntries = files.map((f, i) => ({ rows: rows[i]!, scores: loadPublishedScores('null', f) }))
const nullScores = {} as Record<string, number>
for (const p of PROFILE_NAMES) {
  const t = optimizeThreshold(nullEntries, profiles[p])
  nullScores[p] = scoreAt(nullEntries, profiles[p], t.threshold).score
}

// NAB's published numbers were produced by `run.py` without --optimize for some detectors, i.e.
// at the thresholds stored in config/thresholds.json (found by an older optimiser). Score at
// those too: that is the like-for-like comparison.
const stored = JSON.parse(readFileSync(NAB_DIR + 'config/thresholds.json', 'utf8')) as Record<string, Record<string, { threshold: number }>>

const out: Record<string, Record<string, { ours: number; published: number; diff: number; threshold: number; atStored: number; storedDiff: number }>> = {}
let worstStored = 0
let worst = 0
for (const det of Object.keys(published).sort()) {
  const entries = files.map((f, i) => ({ rows: rows[i]!, scores: loadPublishedScores(det, f) }))
  out[det] = {}
  for (const p of PROFILE_NAMES) {
    const t = optimizeThreshold(entries, profiles[p])
    const raw = scoreAt(entries, profiles[p], t.threshold).score
    const ours = normalize(raw, nullScores[p]!, nWindows, profiles[p])
    const pub = published[det]![p]
    const diff = ours - pub
    worst = Math.max(worst, Math.abs(diff))
    const st = stored[det]![p]!.threshold
    const atStored = normalize(scoreAt(entries, profiles[p], st).score, nullScores[p]!, nWindows, profiles[p])
    worstStored = Math.max(worstStored, Math.abs(atStored - pub))
    out[det]![p] = { ours, published: pub, diff, threshold: t.threshold, atStored, storedDiff: atStored - pub }
  }
}

const lines = [`windows=${nWindows} files=${files.length} null raw scores: ${JSON.stringify(nullScores)}`, '']
lines.push('| detector | profile | published | ours, NAB thresholds.json | difference | ours, re-optimised | difference |', '|---|---|---|---|---|---|---|')
for (const [d, ps] of Object.entries(out)) for (const [p, r] of Object.entries(ps)) {
  lines.push(`| ${d} | ${p} | ${r.published.toFixed(4)} | ${r.atStored.toFixed(4)} | ${r.storedDiff.toExponential(1)} | ${r.ours.toFixed(4)} | ${r.diff.toExponential(1)} |`)
}
lines.push('', `largest |difference| at NAB's stored thresholds: ${worstStored.toExponential(3)}; re-optimised: ${worst.toExponential(3)}`)
console.log(lines.join('\n'))
mkdirSync(new URL('./out/', import.meta.url).pathname, { recursive: true })
writeFileSync(new URL('./out/verify-scorer.json', import.meta.url).pathname, JSON.stringify({ nullScores, out, worst, worstStored }, null, 1))
