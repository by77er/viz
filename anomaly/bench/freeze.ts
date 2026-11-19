/**
 * Freeze, on NAB only, every parameter the second benchmark (SMD, bench/smd-run.ts) uses, and
 * the SMD protocol itself, BEFORE any SMD file is fetched or any detector is run on it.
 *
 *   node --experimental-strip-types bench/freeze.ts     writes bench/smd-frozen.json; refuses to overwrite
 *
 * For each detector, every configuration of its grid in bench/adapters.ts (the grids the NAB
 * held-out protocol searched) is run on all 58 NAB files; alarms are onsets (the first point of
 * each run of flagged points), as in the held-out protocol; per cost profile, the configuration
 * with the highest NAB score over the whole corpus is chosen (ties: the first in grid order).
 * The trivial random baseline's rate is chosen the same way (mean over its five seeds).
 *
 * The file records the time it was written, the SHA-256 of the NAB manifest and of the code that
 * defines the detectors and adapters, and the SMD protocol (corpus, history, windows, tolerance,
 * hypotheses, decision rule). bench/fetch-smd.sh refuses to fetch SMD until this file exists, and
 * bench/smd-run.ts refuses to score if the code it pins has changed or if the data were fetched
 * before the freeze.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { loadCorpus, loadProfiles, sweepRows, scoreAt, normalize, nullScore, PROFILE_NAMES, NAB_DIR, type ProfileName } from './nab.ts'
import { GRIDS, context, runRandom, RANDOM_RATES, RANDOM_SEEDS, type Config } from './adapters.ts'

const HERE = new URL('./', import.meta.url).pathname
const ROOT = new URL('../', import.meta.url).pathname
const OUT = join(HERE, 'smd-frozen.json')
if (existsSync(OUT)) {
  console.error(`${OUT} exists: the configuration is frozen. Delete it only to start a new, separately reported experiment.`)
  process.exit(2)
}

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')

/** The detectors run on SMD. `seasonal_daily` (a forced daily period) is left out: see PROTOCOL.omitted. */
const FROZEN_DETECTORS = [
  'threshold', 'ewma', 'robust_z', 'seasonal', 'stl', 'cusum', 'pelt',
  'robust_z_quantile', 'seasonal_quantile', 'robust_z_posthoc', 'seasonal_posthoc',
] as const

/** Everything about SMD that is decided now, before it is fetched. bench/smd.ts reads these values from the frozen file. */
const PROTOCOL = {
  dataset: {
    name: 'SMD (Server Machine Dataset), from OmniAnomaly: Su et al., "Robust Anomaly Detection for Multivariate Time Series through Stochastic Recurrent Neural Network", KDD 2019',
    source: 'https://raw.githubusercontent.com/NetManAIOps/OmniAnomaly/master/ServerMachineDataset/{train,test,test_label,interpretation_label}/machine-*.txt',
    licence: 'MIT: the repository LICENSE (Copyright (c) 2021 NetManAIOps-OmniAnomaly), read 2026-11-19; the README gives no separate terms for the data. Fetched at run time into bench/data/smd/ (git-ignored); nothing is stored in the repository.',
    machines: 28,
    dimensions: 38,
    stepMs: 60_000,
    originMs: Date.UTC(2019, 0, 1),
    note: 'SMD has no timestamps; rows are taken as 1 minute apart (the paper\'s granularity) from a fixed origin. Parameters are in points, as chosen on NAB (mostly 5-minute data), so their span in time is 5 times shorter here: part of what is tested.',
  },
  corpus: 'One series per (machine, dimension): the training half followed by the test half. A series whose values are all equal over both halves is excluded: it cannot carry a signal.',
  history: 'The training half is history: never scored; it is the adapters\' probationary period (the static threshold\'s range, seasonality detection) and warms every detector, which runs causally over history and test as one series. The whole test half is scored (no NAB probation inside it).',
  segments: 'Per series: the ranges in interpretation_label that list its dimension (dimensions 1-based). Machine segments: maximal runs of 1 in test_label. The index base and inclusivity of interpretation_label ranges are taken as the convention that best matches test_label (reported with the results).',
  windows: {
    rule: 'NAB\'s labeler applied to segments: width w = floor(fraction · nTest / k), k = number of the series\' segments; window = [start − floor(w/2), end + floor(w/2)], clipped to the test half; overlapping windows merged.',
    fraction: 0.1,
  },
  dontCare: 'For a series, a machine segment that does not list its dimension, widened by the tolerance on both sides, is not scored outside the series\' own windows: an alarm there is neither true nor false (the labels say the machine was anomalous, not whether this dimension showed it). The same spans are excluded from event precision.',
  scoring: 'NAB\'s scorer (bench/nab.ts: scaled sigmoid, first detection per window, FP weighting, three cost profiles), detections = alarm onsets, normalised over the corpus: 100·(raw − null)/(perfect − null), perfect = windows · tpWeight. Each profile is scored with the configuration frozen for that profile.',
  event: {
    rule: 'Event-level, with a fixed tolerance: a series segment is detected if an alarm onset of that series lies in [start − tolerance, end + tolerance]; an onset is true if it lies in such a span of any segment of its series, false otherwise (onsets in don\'t-care spans excluded). Precision = true onsets / counted onsets; recall = detected segments / segments; F1 = 2PR/(P+R); pooled over the corpus. Delay = first matching onset − segment start, in points. Computed with each profile\'s configuration; the standard profile\'s is the headline.',
    tolerancePoints: 15,
    why: 'A quarter of an hour at 1-minute steps: about a `for: 5m` plus two evaluation intervals. Chosen before any SMD result; not varied.',
  },
  machineView: 'Secondary: a machine is flagged while any of its series is flagged; its alarm onsets are the onsets of that union. Events = machine segments; same tolerance; also unmatched onsets per machine-day of test data.',
  bootstrap: { unit: 'machine', resamples: 2000, seed: 20261119, interval: 0.95, what: 'paired differences of the normalised score (per profile) and of event F1 against EWMA and the static threshold' },
  trivial: 'Random: each row flagged with probability p (seeded, data never read); p frozen per profile on NAB; reported as the mean over seeds 1-5.',
  omitted: 'seasonal_daily (a daily period forced where none is detected) is not run: it existed on NAB because a 750-row probation could be too short to detect a daily period; SMD\'s history is 2-3 weeks. It would also add about 40 minutes of CPU.',
  hypotheses: [
    'H1: robust_z_quantile > ewma (standard)',
    'H2: seasonal_quantile > ewma (standard)',
    'H3: ewma > threshold (standard)',
    'H4: threshold > ewma (reward_low_FP_rate)',
    'H5: robust_z (MAD) < threshold and seasonal (MAD) < threshold (standard)',
    'H6: cusum, stl and pelt < threshold (standard)',
    'H7: robust_z_quantile > robust_z_posthoc (MAD with k up to 40): the spread, not only a larger k (standard)',
    'H8: threshold > random (standard)',
  ],
  decision: 'The quantile spread (robust_z_quantile; separately seasonal_quantile) GENERALISES if, on SMD, standard profile: its normalised score exceeds both EWMA\'s and the static threshold\'s, its event F1 exceeds EWMA\'s, and the 95% machine-bootstrap interval of its score minus EWMA\'s lies above 0. Point estimates in its favour with an interval that includes 0: NOT CONFIRMED. Otherwise: DOES NOT GENERALISE. D33 says the quantile spread becomes the default for non-paging rules if it holds; anything short of GENERALISES leaves D33 as it is on that point.',
}

// ───────────────────────────── tune on NAB ─────────────────────────────

const manifestText = readFileSync(join(HERE, 'nab-manifest.json'), 'utf8')
const manifest = JSON.parse(manifestText) as Record<string, string>
const files = loadCorpus()
for (const f of files) {
  if (manifest[`data/${f.path}`] !== sha(readFileSync(`${NAB_DIR}data/${f.path}`))) { console.error(`NAB file differs from the manifest: ${f.path}`); process.exit(2) }
}
const profiles = loadProfiles()
const rows = files.map((f) => sweepRows(f))
const ctxs = files.map(context)
const nWindows = files.reduce((a, f) => a + f.windows.length, 0)
const nulls = Object.fromEntries(PROFILE_NAMES.map((p) => [p, nullScore(rows.map((r) => ({ rows: r })), profiles[p])])) as Record<ProfileName, number>

function onsets(flags: ArrayLike<number>): Float64Array {
  const o = new Float64Array(flags.length)
  for (let i = 0; i < flags.length; i++) if (flags[i] && !(i > 0 && flags[i - 1])) o[i] = 1
  return o
}
function nabScores(sig: Float64Array[]): Record<ProfileName, number> {
  const out = {} as Record<ProfileName, number>
  for (const p of PROFILE_NAMES) {
    const raw = scoreAt(sig.map((s, i) => ({ rows: rows[i]!, scores: s })), profiles[p], 0.5).score
    out[p] = normalize(raw, nulls[p], nWindows, profiles[p])
  }
  return out
}

type Choice = { label: string; params: Record<string, number | string>; nabInSample: number }
const chosen: Record<string, Record<ProfileName, Choice>> = {}
const searched: Record<string, { label: string; scores: Record<ProfileName, number> }[]> = {}
const t0 = performance.now()
for (const name of FROZEN_DETECTORS) {
  const grid: Config[] = GRIDS[name]!
  searched[name] = []
  for (const cfg of grid) {
    const sig = files.map((f, i) => onsets(cfg.run(f, ctxs[i]!).flags))
    searched[name]!.push({ label: cfg.label, scores: nabScores(sig) })
  }
  chosen[name] = {} as Record<ProfileName, Choice>
  for (const p of PROFILE_NAMES) {
    let best = 0
    searched[name]!.forEach((s, j) => { if (s.scores[p] > searched[name]![best]!.scores[p]) best = j })
    chosen[name]![p] = { label: grid[best]!.label, params: grid[best]!.params, nabInSample: searched[name]![best]!.scores[p] }
  }
  console.error(`${name}: ${PROFILE_NAMES.map((p) => `${chosen[name]![p].label} ${chosen[name]![p].nabInSample.toFixed(1)}`).join(' | ')}  (${((performance.now() - t0) / 1000).toFixed(0)} s)`)
}
// trivial random baseline
searched.random = []
for (const rate of RANDOM_RATES) {
  const per = RANDOM_SEEDS.map((seed) => nabScores(files.map((f) => onsets(runRandom(f.values.length, f.path, rate, seed).flags))))
  const mean = Object.fromEntries(PROFILE_NAMES.map((p) => [p, per.reduce((a, s) => a + s[p], 0) / per.length])) as Record<ProfileName, number>
  searched.random.push({ label: `random(p=${rate})`, scores: mean })
}
chosen.random = {} as Record<ProfileName, Choice>
for (const p of PROFILE_NAMES) {
  let best = 0
  searched.random.forEach((s, j) => { if (s.scores[p] > searched.random![best]!.scores[p]) best = j })
  chosen.random[p] = { label: searched.random[best]!.label, params: { p: RANDOM_RATES[best]!, seeds: RANDOM_SEEDS.join(',') }, nabInSample: searched.random[best]!.scores[p] }
}
console.error(`random: ${PROFILE_NAMES.map((p) => chosen.random![p].label).join(' | ')}`)

// The README's NAB held-out numbers, for comparison (bench/out/nab-results.json, if present).
let nabHeldOut: Record<string, Record<ProfileName, number>> | null = null
const heldPath = join(HERE, 'out/nab-results.json')
if (existsSync(heldPath)) {
  const r = JSON.parse(readFileSync(heldPath, 'utf8')) as { heldOut: Record<string, Record<ProfileName, { score: number }>>; baselines?: Record<string, { onsets: Record<ProfileName, { score: number }> }> }
  nabHeldOut = {}
  for (const [d, c] of Object.entries(r.heldOut)) nabHeldOut[d] = Object.fromEntries(PROFILE_NAMES.map((p) => [p, c[p].score])) as Record<ProfileName, number>
  if (r.baselines?.random) nabHeldOut['random (NAB published, as onsets)'] = Object.fromEntries(PROFILE_NAMES.map((p) => [p, r.baselines!.random!.onsets[p].score])) as Record<ProfileName, number>
}

// Code the configuration depends on: the library and the adapters.
const srcFiles = (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).sort()
const code = {
  src: sha(srcFiles.map((f) => `${f}\n${readFileSync(join(ROOT, 'src', f), 'utf8')}`).join('\n')),
  'bench/adapters.ts': sha(readFileSync(join(HERE, 'adapters.ts'))),
  'bench/nab.ts': sha(readFileSync(join(HERE, 'nab.ts'))),
}

const frozen = {
  frozenAt: new Date().toISOString(),
  statement: 'Written by bench/freeze.ts from NAB alone, before any SMD file was fetched and before any detector was run on SMD. Nothing below may be changed after SMD is scored; a change is a new experiment, reported as such.',
  nab: { manifestSha256: sha(manifestText), files: files.length, windows: nWindows, heldOutResultsSha256: existsSync(heldPath) ? sha(readFileSync(heldPath)) : null },
  code,
  protocol: PROTOCOL,
  detectors: chosen,
  nabHeldOut,
  searched,
  tuningSeconds: (performance.now() - t0) / 1000,
}
writeFileSync(OUT, JSON.stringify(frozen, null, 1) + '\n')
console.error(`wrote ${OUT} at ${frozen.frozenAt}`)
