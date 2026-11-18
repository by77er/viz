/**
 * Score every detector on the Numenta Anomaly Benchmark.
 *
 *   bash bench/fetch-nab.sh --results
 *   node --experimental-strip-types bench/nab-run.ts            all detectors
 *   node --experimental-strip-types bench/nab-run.ts ewma cusum  some
 *
 * Two protocols:
 *
 * 1. NAB protocol (comparable with NAB's scoreboard, and optimistic): each detector at its
 *    default parameters; its continuous score s mapped to s / (1 + s) ∈ [0, 1); every row is a
 *    detection when that is ≥ the threshold; the threshold optimised per profile over the
 *    whole corpus — exactly how NAB's published numbers were produced (see verify-scorer.ts).
 *
 * 2. Held-out (honest): files are split into two folds, alternating within each category in
 *    path order (fold A = even positions, fold B = odd). For each profile, all parameters
 *    including the detector's own threshold are chosen on one fold and the detector is scored
 *    on the other, both ways; the two test halves are summed and normalised over the whole
 *    corpus. Detections are alarm onsets: the first point of each run of flagged points, which
 *    is what a monitor pages on. NAB's own detectors are re-scored the same way from their
 *    published per-row outputs (threshold chosen on the other fold), both as points (NAB's
 *    convention) and as onsets.
 *
 * Writes bench/out/nab-results.json and prints Markdown tables.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  loadCorpus, loadProfiles, loadPublishedScores, publishedFinalResults, sweepRows, optimizeThreshold, scoreAt,
  normalize, nullScore, windowMetrics, PROFILE_NAMES, NAB_DIR, type NabFile, type SweepRows, type ProfileName, type CostMatrix,
} from './nab.ts'
import { GRIDS, DEFAULT_CONFIGS, context, type Config, type Ctx } from './adapters.ts'

const only = process.argv.slice(2)
const OUT = new URL('./out/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

// ───────────────────────────── corpus, manifest, folds ─────────────────────────────

const files = loadCorpus()
const profiles = loadProfiles()
const rows = files.map(sweepRows)
const ctxs = files.map(context)
const manifestPath = new URL('./nab-manifest.json', import.meta.url).pathname
const manifest: Record<string, string> = {}
for (const f of files) manifest[`data/${f.path}`] = createHash('sha256').update(readFileSync(`${NAB_DIR}data/${f.path}`)).digest('hex')
for (const l of ['labels/combined_windows.json', 'labels/combined_labels.json', 'config/profiles.json']) manifest[l] = createHash('sha256').update(readFileSync(`${NAB_DIR}${l}`)).digest('hex')
if (existsSync(manifestPath)) {
  const old = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, string>
  const diff = Object.keys({ ...old, ...manifest }).filter((k) => old[k] !== manifest[k])
  if (diff.length) { console.error(`NAB files differ from bench/nab-manifest.json: ${diff.slice(0, 5).join(', ')}`); process.exit(2) }
} else writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n')

const fold = new Map<string, 'A' | 'B'>()
const byCat = new Map<string, NabFile[]>()
for (const f of files) byCat.set(f.category, [...(byCat.get(f.category) ?? []), f])
for (const fs of byCat.values()) fs.sort((a, b) => a.path.localeCompare(b.path)).forEach((f, i) => fold.set(f.path, i % 2 === 0 ? 'A' : 'B'))
const idxOf = (pred: (f: NabFile) => boolean) => files.map((f, i) => (pred(f) ? i : -1)).filter((i) => i >= 0)
const FOLD = { A: idxOf((f) => fold.get(f.path) === 'A'), B: idxOf((f) => fold.get(f.path) === 'B') }
const ALL = files.map((_, i) => i)
const CATS = [...byCat.keys()].sort()
const windowsIn = (ix: number[]) => ix.reduce((a, i) => a + files[i]!.windows.length, 0)
const nullIn = (ix: number[], cm: CostMatrix) => nullScore(ix.map((i) => ({ rows: rows[i]! })), cm)
const norm = (raw: number, ix: number[], cm: CostMatrix) => normalize(raw, nullIn(ix, cm), windowsIn(ix), cm)

// ───────────────────────────── helpers ─────────────────────────────

/** Alarm onsets: 1 at the first flagged point of each run. */
function onsets(flags: ArrayLike<number>): Float64Array {
  const o = new Float64Array(flags.length)
  for (let i = 0; i < flags.length; i++) if (flags[i] && !(i > 0 && flags[i - 1])) o[i] = 1
  return o
}
const entries = (ix: number[], sig: (i: number) => ArrayLike<number>) => ix.map((i) => ({ rows: rows[i]!, scores: sig(i) }))
const rawAt = (ix: number[], sig: (i: number) => ArrayLike<number>, cm: CostMatrix, t: number) => scoreAt(entries(ix, sig), cm, t).score

interface Cv { score: number; perFold: Record<'A' | 'B', { chosen: string; tuneScore: number; testRaw: number; threshold?: number }>; testSignal: Map<number, Float64Array> }

/** Choose on one fold, test on the other, both ways. `evalOn(ix, choice)` → raw; choices enumerated by the caller. */
function crossValidate<C>(choices: C[], name: (c: C) => string, signal: (c: C, i: number) => Float64Array, cm: CostMatrix, thresholdOf: (c: C, ix: number[]) => number): Cv {
  const perFold = {} as Cv['perFold']
  const testSignal = new Map<number, Float64Array>()
  let total = 0
  for (const [tune, test] of [['A', 'B'], ['B', 'A']] as const) {
    let best: { c: C; raw: number; t: number } | null = null
    for (const c of choices) {
      const t = thresholdOf(c, FOLD[tune])
      const raw = rawAt(FOLD[tune], (i) => signal(c, i), cm, t)
      if (!best || raw > best.raw) best = { c, raw, t }
    }
    const testRaw = rawAt(FOLD[test], (i) => signal(best!.c, i), cm, best!.t)
    for (const i of FOLD[test]) {
      const s = signal(best!.c, i)
      const d = new Float64Array(s.length)
      for (let j = 0; j < s.length; j++) d[j] = s[j]! >= best!.t ? 1 : 0
      testSignal.set(i, d)
    }
    total += testRaw
    perFold[test] = { chosen: name(best!.c), tuneScore: norm(best!.raw, FOLD[tune], cm), testRaw, threshold: best!.t }
  }
  return { score: norm(total, ALL, cm), perFold, testSignal }
}

/** Per-category normalised score and window metrics of held-out detections (each file is tested once). */
function breakdown(det: Map<number, Float64Array>, cm: CostMatrix) {
  const cats: Record<string, number> = {}
  for (const c of CATS) {
    const ix = idxOf((f) => f.category === c)
    cats[c] = norm(rawAt(ix, (i) => det.get(i)!, cm, 0.5), ix, cm)
  }
  const wm = windowMetrics(ALL.map((i) => ({ file: files[i]!, rows: rows[i]!, detections: det.get(i)! })))
  const stepMin = (i: number) => ctxs[i]!.stepMs / 60_000
  void stepMin
  const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]! : NaN)
  // the seasonal subset: files where seasonality was detected on the probationary period
  const seasonalIx = idxOf((f) => ctxs[files.indexOf(f)]!.periodMs !== null)
  const seasonalSubset = norm(rawAt(seasonalIx, (i) => det.get(i)!, cm, 0.5), seasonalIx, cm)
  const nonSeasonalIx = idxOf((f) => ctxs[files.indexOf(f)]!.periodMs === null)
  const nonSeasonalSubset = norm(rawAt(nonSeasonalIx, (i) => det.get(i)!, cm, 0.5), nonSeasonalIx, cm)
  const perFile = Object.fromEntries(ALL.map((i) => [files[i]!.path, scoreAt([{ rows: rows[i]!, scores: det.get(i)! }], cm, 0.5)]))
  return { categories: cats, seasonalSubset, nonSeasonalSubset, perFile, recall: wm.recall, precision: wm.precision, windows: wm.windows, detected: wm.detectedWindows, events: wm.events, medianDelayFromLabelPoints: med(wm.delaysFromLabel), medianDelayFromWindowStartPoints: med(wm.delaysFromStart) }
}

// ───────────────────────────── 1. NAB protocol ─────────────────────────────

const t0 = performance.now()
const results: Record<string, unknown> = { folds: Object.fromEntries(files.map((f) => [f.path, fold.get(f.path)])), seasonality: Object.fromEntries(files.map((f, i) => [f.path, ctxs[i]!.seasonalityText])) }
const nabProtocol: Record<string, Record<ProfileName, number>> = {}
const cpu: Record<string, { ms: number; points: number }> = {}
for (const cfg of DEFAULT_CONFIGS) {
  if (only.length && !only.includes(cfg.detector)) continue
  const start = process.cpuUsage()
  const runs = files.map((f, i) => cfg.run(f, ctxs[i]!))
  const used = process.cpuUsage(start)
  cpu[cfg.detector] = { ms: (used.user + used.system) / 1000, points: files.reduce((a, f) => a + f.values.length, 0) }
  const sig = runs.map((r) => r.scores.map((s) => s / (1 + s)))
  nabProtocol[cfg.label] = {} as Record<ProfileName, number>
  for (const p of PROFILE_NAMES) {
    const t = optimizeThreshold(entries(ALL, (i) => sig[i]!), profiles[p])
    nabProtocol[cfg.label]![p] = norm(scoreAt(entries(ALL, (i) => sig[i]!), profiles[p], t.threshold).score, ALL, profiles[p])
  }
  console.error(`nab protocol ${cfg.label}: ${JSON.stringify(nabProtocol[cfg.label])}`)
}
results.nabProtocol = nabProtocol
results.cpuOnCorpus = cpu

// ───────────────────────────── 2. held-out ─────────────────────────────

type Cell = { score: number; perFold: Cv['perFold']; breakdown: ReturnType<typeof breakdown> }
const heldOut: Record<string, Record<ProfileName, Cell>> = {}

for (const [name, configs] of Object.entries(GRIDS)) {
  if (only.length && !only.includes(name)) continue
  const sigs = configs.map((cfg: Config) => files.map((f, i) => onsets(cfg.run(f, ctxs[i] as Ctx).flags)))
  heldOut[name] = {} as Record<ProfileName, Cell>
  for (const p of PROFILE_NAMES) {
    const cv = crossValidate(configs.map((_, j) => j), (j) => configs[j]!.label, (j, i) => sigs[j]![i]!, profiles[p], () => 0.5)
    heldOut[name]![p] = { score: cv.score, perFold: cv.perFold, breakdown: breakdown(cv.testSignal, profiles[p]) }
  }
  console.error(`held-out ${name}: ${PROFILE_NAMES.map((p) => heldOut[name]![p].score.toFixed(1)).join(' / ')}  (${((performance.now() - t0) / 1000).toFixed(0)} s)`)
}

// NAB's published detectors through the same held-out protocol
const published = publishedFinalResults()
const baselines: Record<string, { points: Record<ProfileName, Cell>; onsets: Record<ProfileName, Cell>; published: Record<ProfileName, number> }> = {}
if (!only.length || only.includes('baselines')) {
  for (const det of ['null', 'random', 'windowedGaussian', 'relativeEntropy', 'skyline', 'twitterADVec', 'numenta', 'knncad', 'randomCutForest', 'earthgeckoSkyline', 'ARTime']) {
    const sc = files.map((f) => loadPublishedScores(det, f))
    const b = { points: {} as Record<ProfileName, Cell>, onsets: {} as Record<ProfileName, Cell>, published: published[det]! }
    for (const p of PROFILE_NAMES) {
      // points: threshold chosen by NAB's exact sweep on the tuning fold
      const cv = crossValidate([0], () => 'threshold', (_c, i) => sc[i]!, profiles[p], (_c, ix) => optimizeThreshold(entries(ix, (i) => sc[i]!), profiles[p]).threshold)
      b.points[p] = { score: cv.score, perFold: cv.perFold, breakdown: breakdown(cv.testSignal, profiles[p]) }
      // onsets: thresholds from the score quantiles, searched on the tuning fold
      const all = Float64Array.from(sc.flatMap((a) => Array.from(a))).sort()
      const cands = [...new Set(Array.from({ length: 120 }, (_, q) => all[Math.min(all.length - 1, Math.floor(all.length * (1 - Math.pow(10, -0.05 * q - 0.5))))]!))]
      const on = new Map<string, Float64Array[]>()
      const sigFor = (t: number) => { const k = String(t); if (!on.has(k)) on.set(k, sc.map((a) => onsets(Array.from(a, (v) => (v >= t ? 1 : 0))))); return on.get(k)! }
      const cv2 = crossValidate(cands, (t) => `threshold=${t}`, (t, i) => sigFor(t)[i]!, profiles[p], () => 0.5)
      b.onsets[p] = { score: cv2.score, perFold: cv2.perFold, breakdown: breakdown(cv2.testSignal, profiles[p]) }
    }
    baselines[det] = b
    console.error(`baseline ${det}: points ${PROFILE_NAMES.map((p) => b.points[p].score.toFixed(1)).join(' / ')}; onsets ${PROFILE_NAMES.map((p) => b.onsets[p].score.toFixed(1)).join(' / ')}`)
  }
}
results.heldOut = heldOut
results.baselines = baselines
results.elapsedSeconds = (performance.now() - t0) / 1000

const file = only.length ? `${OUT}nab-results.${only.join('-')}.json` : `${OUT}nab-results.json`
writeFileSync(file, JSON.stringify(results, null, 1))

// ───────────────────────────── tables ─────────────────────────────

const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '–')
const lines: string[] = []
lines.push('### NAB protocol (defaults, threshold optimised on the whole corpus)', '', '| detector | standard | reward low FP | reward low FN |', '|---|---|---|---|')
for (const [d, r] of Object.entries(nabProtocol)) lines.push(`| ${d} | ${f1(r.standard)} | ${f1(r.reward_low_FP_rate)} | ${f1(r.reward_low_FN_rate)} |`)
for (const [d, b] of Object.entries(baselines)) lines.push(`| NAB published: ${d} | ${f1(b.published.standard)} | ${f1(b.published.reward_low_FP_rate)} | ${f1(b.published.reward_low_FN_rate)} |`)
lines.push('', '### Held-out (2-fold, parameters and threshold chosen on the other fold)', '', '| detector | standard | reward low FP | reward low FN | window recall | event precision | median delay (points from label) | chosen (std, fold A / fold B) |', '|---|---|---|---|---|---|---|---|')
const row = (name: string, c: Record<ProfileName, Cell>) => {
  const s = c.standard
  lines.push(`| ${name} | ${f1(c.standard.score)} | ${f1(c.reward_low_FP_rate.score)} | ${f1(c.reward_low_FN_rate.score)} | ${(100 * s.breakdown.recall).toFixed(0)}% | ${(100 * s.breakdown.precision).toFixed(0)}% | ${s.breakdown.medianDelayFromLabelPoints} | ${s.perFold.A.chosen} / ${s.perFold.B.chosen} |`)
}
for (const [d, c] of Object.entries(heldOut)) row(d, c)
for (const [d, b] of Object.entries(baselines)) { row(`NAB ${d} (points)`, b.points); row(`NAB ${d} (onsets)`, b.onsets) }
lines.push('', '### Held-out, standard profile, by category', '', `| detector | ${CATS.join(' | ')} |`, `|---|${CATS.map(() => '---').join('|')}|`)
for (const [d, c] of Object.entries(heldOut)) lines.push(`| ${d} | ${CATS.map((k) => f1(c.standard.breakdown.categories[k]!)).join(' | ')} |`)
for (const [d, b] of Object.entries(baselines)) lines.push(`| NAB ${d} (points) | ${CATS.map((k) => f1(b.points.standard.breakdown.categories[k]!)).join(' | ')} |`)
lines.push('', `### Held-out, standard profile: files with and without detected seasonality (${idxOf((f) => ctxs[files.indexOf(f)]!.periodMs !== null).length} / ${idxOf((f) => ctxs[files.indexOf(f)]!.periodMs === null).length} files)`, '', '| detector | seasonal files | non-seasonal files |', '|---|---|---|')
for (const [d, c] of Object.entries(heldOut)) lines.push(`| ${d} | ${f1(c.standard.breakdown.seasonalSubset)} | ${f1(c.standard.breakdown.nonSeasonalSubset)} |`)
for (const [d, b] of Object.entries(baselines)) lines.push(`| NAB ${d} (points) | ${f1(b.points.standard.breakdown.seasonalSubset)} | ${f1(b.points.standard.breakdown.nonSeasonalSubset)} |`)
lines.push('', `CPU on the corpus (${files.reduce((a, f) => a + f.values.length, 0)} points, default configs, ms per 1,000 points, including adapter work): ${Object.entries(cpu).map(([d, c]) => `${d} ${((1000 * c.ms) / c.points).toFixed(2)}`).join(', ')}`)
console.log(lines.join('\n'))
writeFileSync(file.replace(/\.json$/, '.md'), lines.join('\n') + '\n')
