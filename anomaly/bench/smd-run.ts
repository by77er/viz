/**
 * Score every detector on SMD, the Server Machine Dataset, with the configuration frozen on NAB
 * (bench/smd-frozen.json, written by bench/freeze.ts before SMD was fetched). Nothing is tuned here.
 *
 *   node --experimental-strip-types bench/freeze.ts     once, before fetching (refuses to overwrite)
 *   bash bench/fetch-smd.sh                             refuses to run before the freeze
 *   node --experimental-strip-types bench/smd-run.ts    run, resuming from bench/out/smd-cache/, then score
 *   node --experimental-strip-types bench/smd-run.ts --score   score from the cache only
 *
 * Refuses to run if the library, the adapters or the NAB scorer differ from what the freeze
 * pinned, if the data were first fetched before the freeze, or if the SMD files differ from
 * bench/smd-manifest.json (written on the first run). Writes bench/out/smd-results.{json,md}.
 * The protocol (series, history, windows, don't-care spans, tolerance, hypotheses, decision rule)
 * is read from the frozen file; bench/smd.ts implements it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { loadProfiles, scoreAt, nullScore, PROFILE_NAMES, type NabFile, type ProfileName, type CostMatrix } from './nab.ts'
import { GRIDS, runRandom, type Ctx, type Run } from './adapters.ts'
import { detectSeasonality, robustZ } from '../src/index.ts'
import {
  SMD_DIR, SMD_MACHINES, CONVENTIONS, loadMachine, conventionAgreement, runsOf, seriesSegments, nabWindows, dontCareSpans,
  seriesRows, testRuns, onsetsOf, unionRuns, onsetSignal, eventCounts, prf, spanIndex, bootstrapInterval, weightedNormalised,
  type Convention, type EventCounts, type Span,
} from './smd.ts'

const HERE = new URL('./', import.meta.url).pathname
const ROOT = new URL('../', import.meta.url).pathname
const OUT = join(HERE, 'out')
const CACHE = join(OUT, 'smd-cache')
mkdirSync(CACHE, { recursive: true })
const scoreOnly = process.argv.includes('--score')
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')
const log = (s: string) => console.error(`[${new Date().toISOString()}] ${s}`)

// ───────────────────────────── integrity ─────────────────────────────

type Choice = { label: string; params: Record<string, number | string>; nabInSample: number }
interface Frozen {
  frozenAt: string
  code: Record<string, string>
  protocol: {
    dataset: { stepMs: number; originMs: number }
    windows: { fraction: number }
    event: { tolerancePoints: number }
    bootstrap: { resamples: number; seed: number; interval: number }
    decision: string
    hypotheses: string[]
  }
  detectors: Record<string, Record<ProfileName, Choice>>
  nabHeldOut: Record<string, Record<ProfileName, number>> | null
}
const frozenText = readFileSync(join(HERE, 'smd-frozen.json'), 'utf8')
const frozen = JSON.parse(frozenText) as Frozen
const frozenSha = sha(frozenText)
const P = frozen.protocol
const TOL = P.event.tolerancePoints

const srcFiles = (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).sort()
const codeNow: Record<string, string> = {
  src: sha(srcFiles.map((f) => `${f}\n${readFileSync(join(ROOT, 'src', f), 'utf8')}`).join('\n')),
  'bench/adapters.ts': sha(readFileSync(join(HERE, 'adapters.ts'))),
  'bench/nab.ts': sha(readFileSync(join(HERE, 'nab.ts'))),
}
const changed = Object.keys(frozen.code).filter((k) => frozen.code[k] !== codeNow[k])
if (changed.length) { console.error(`code changed since the freeze: ${changed.join(', ')}; the frozen configuration no longer describes what would run`); process.exit(2) }

const fetchedAtPath = join(SMD_DIR, 'FETCHED_AT')
if (!existsSync(fetchedAtPath)) { console.error('SMD not fetched: bash bench/fetch-smd.sh'); process.exit(2) }
const fetchedAt = readFileSync(fetchedAtPath, 'utf8').trim()
if (!(Date.parse(fetchedAt) >= Date.parse(frozen.frozenAt))) { console.error(`SMD first fetched ${fetchedAt}, before the freeze ${frozen.frozenAt}: refusing`); process.exit(2) }

const manifestPath = join(HERE, 'smd-manifest.json')
const manifest: Record<string, string> = {}
for (const part of ['train', 'test', 'test_label', 'interpretation_label']) for (const m of SMD_MACHINES) manifest[`${part}/${m}.txt`] = sha(readFileSync(join(SMD_DIR, part, `${m}.txt`)))
if (existsSync(manifestPath)) {
  const old = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, string>
  const diff = Object.keys({ ...old, ...manifest }).filter((k) => old[k] !== manifest[k])
  if (diff.length) { console.error(`SMD files differ from bench/smd-manifest.json: ${diff.slice(0, 5).join(', ')}`); process.exit(2) }
} else writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n')

// ───────────────────────────── jobs ─────────────────────────────

const argOf = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
/** --only=a,b: run only these detectors in this pass (the cache keeps earlier passes). */
const onlyDetectors = argOf('only')?.split(',') ?? null
/** --machines=1-1,2-3: run only these machines in this pass (no scoring unless all are cached). */
const onlyMachines = argOf('machines')?.split(',').map((m) => (m.startsWith('machine-') ? m : `machine-${m}`)) ?? null

const DETECTORS = Object.keys(frozen.detectors).filter((d) => d !== 'random')
/** The robust z family: one detector call per group of configurations that differ only in k (see runGroup). */
const ROBUST_Z = new Set(['robust_z', 'robust_z_quantile', 'robust_z_posthoc'])
interface Job { key: string; detector: string; params: Record<string, number | string>; run: (f: NabFile, c: Ctx, key: string) => Run }
const jobs = new Map<string, Job>()
/** Job keys per (detector, profile); random has one per seed. */
const jobOf: Record<string, Record<ProfileName, string[]>> = {}
for (const d of DETECTORS) {
  jobOf[d] = {} as Record<ProfileName, string[]>
  for (const p of PROFILE_NAMES) {
    const label = frozen.detectors[d]![p].label
    const cfg = GRIDS[d]!.find((c) => c.label === label)
    if (!cfg) throw new Error(`frozen ${d} ${label} not in GRIDS`)
    jobs.set(label, { key: label, detector: d, params: cfg.params, run: (f, c) => cfg.run(f, c) })
    jobOf[d]![p] = [label]
  }
}
jobOf.random = {} as Record<ProfileName, string[]>
for (const p of PROFILE_NAMES) {
  const rate = Number(frozen.detectors.random![p].params.p)
  const seeds = String(frozen.detectors.random![p].params.seeds).split(',').map(Number)
  jobOf.random[p] = seeds.map((seed) => {
    const key = `random(p=${rate},seed=${seed})`
    jobs.set(key, { key, detector: 'random', params: { p: rate, seed }, run: (f, _c, k) => runRandom(f.values.length, k, rate, seed) })
    return key
  })
}
const selected = [...jobs.values()].filter((j) => !onlyDetectors || onlyDetectors.includes(j.detector))
log(`${jobs.size} distinct runs per series; this pass: ${selected.map((j) => j.key).join(', ')}`)

// ───────────────────────────── run (cached per machine) ─────────────────────────────

interface SeriesCache { dim: number; periodMs: number | null; seasonality: string; runs: Record<string, number[]> }
interface MachineCache { frozenSha: string; machine: string; nTrain: number; nTest: number; excluded: number[]; series: SeriesCache[]; cpuMs: Record<string, number>; points: number; verified: string[] }

/**
 * The robust z family, exactly as its adapter (robustZ.detect over the whole series with the
 * frozen parameters) but cheaper: (1) its state at a point is the set of points in the trailing
 * window, so starting windowPoints + 8 points before the test half gives the same test-half
 * output; (2) with minDeviation 0 and direction 'both' (the adapters' defaults) a point is
 * anomalous iff status is ok and score > k, so configurations that differ only in k share one
 * call. Both are checked against the plain adapter on the first series of every machine.
 */
function runGroup(f: NabFile, c: Ctx, group: Job[]): Map<string, Uint8Array> {
  const params = { ...group[0]!.params }
  delete params.k
  const from = Math.max(0, c.prob - Number(params.windowPoints) - 8)
  const series = { ts: f.ts.subarray(from), values: f.values.subarray(from) }
  const kMin = Math.min(...group.map((j) => Number(j.params.k)))
  const pts = robustZ.detect(series, { ...params, k: kMin, stepMs: c.stepMs } as never).points
  const out = new Map<string, Uint8Array>()
  for (const j of group) {
    const k = Number(j.params.k)
    const flags = new Uint8Array(f.values.length)
    pts.forEach((p, i) => { if (p.status === 'ok' && p.score > k) flags[from + i] = 1 })
    out.set(j.key, flags)
  }
  return out
}

function runMachine(name: string, prev: MachineCache | null, want: Job[]): MachineCache {
  const m = loadMachine(name)
  const n = m.nTrain + m.nTest
  const ts = Float64Array.from({ length: n }, (_, i) => P.dataset.originMs + i * P.dataset.stepMs)
  const out: MachineCache = prev ?? { frozenSha, machine: name, nTrain: m.nTrain, nTest: m.nTest, excluded: [], series: [], cpuMs: {}, points: 0, verified: [] }
  const fresh = !prev
  let first = true
  for (let d = 0; d < m.train.length; d++) {
    const values = new Float64Array(n)
    values.set(m.train[d]!, 0)
    values.set(m.test[d]!, m.nTrain)
    let lo = Infinity, hi = -Infinity
    for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v }
    if (!(hi > lo)) { if (fresh) out.excluded.push(d + 1); continue }
    const f: NabFile = { path: `${name}/${d + 1}`, category: name, stamps: [], ts, values, windows: [], labels: [] }
    let sc = out.series.find((s) => s.dim === d + 1)
    if (!sc) {
      const s = detectSeasonality({ ts: ts.subarray(0, m.nTrain), values: values.subarray(0, m.nTrain) }, { stepMs: P.dataset.stepMs })
      sc = { dim: d + 1, periodMs: s.periodMs, seasonality: s.text, runs: {} }
      out.series.push(sc)
      out.points += n
    }
    const ctx: Ctx = { stepMs: P.dataset.stepMs, prob: m.nTrain, periodMs: sc.periodMs, seasonalityText: sc.seasonality }
    const todo = want.filter((j) => !(j.key in sc!.runs))
    const cpu = (key: string, t0: NodeJS.CpuUsage) => { const u = process.cpuUsage(t0); out.cpuMs[key] = (out.cpuMs[key] ?? 0) + (u.user + u.system) / 1000 }
    // robust z family in groups
    const groups = new Map<string, Job[]>()
    for (const j of todo.filter((j) => ROBUST_Z.has(j.detector))) {
      const { k: _k, ...rest } = j.params
      const g = JSON.stringify(rest)
      groups.set(g, [...(groups.get(g) ?? []), j])
    }
    for (const group of groups.values()) {
      const t0 = process.cpuUsage()
      const flags = runGroup(f, ctx, group)
      cpu(group.map((j) => j.key).join(' + '), t0)
      for (const j of group) {
        sc.runs[j.key] = testRuns(flags.get(j.key)!, m.nTrain)
        if (first) { // the check: the plain adapter over the whole series gives the same test-half runs
          const plain = testRuns(j.run(f, ctx, f.path).flags, m.nTrain)
          if (JSON.stringify(plain) !== JSON.stringify(sc.runs[j.key])) throw new Error(`${name}/${d + 1} ${j.key}: grouped run differs from the adapter`)
          out.verified.push(`${d + 1}:${j.key}`)
        }
      }
    }
    for (const j of todo.filter((j) => !ROBUST_Z.has(j.detector))) {
      const t0 = process.cpuUsage()
      const r = j.run(f, ctx, f.path)
      cpu(j.key, t0)
      sc.runs[j.key] = testRuns(r.flags, m.nTrain)
    }
    first = false
  }
  return out
}

const t0 = performance.now()
const caches: (MachineCache | null)[] = []
for (const name of SMD_MACHINES) {
  const p = join(CACHE, `${name}.json`)
  let c: MachineCache | null = null
  if (existsSync(p)) {
    const old = JSON.parse(readFileSync(p, 'utf8')) as MachineCache
    if (old.frozenSha === frozenSha) c = old
  }
  const missing = (cc: MachineCache | null) => selected.filter((j) => !cc || cc.series.length === 0 || cc.series.some((s) => !(j.key in s.runs)))
  if (!scoreOnly && (!onlyMachines || onlyMachines.includes(name)) && missing(c).length) {
    const start = performance.now()
    c = runMachine(name, c, missing(c))
    writeFileSync(p, JSON.stringify(c))
    log(`${name}: ${c.series.length} series (${c.excluded.length} constant, excluded), ${missing(null).length} runs, ${((performance.now() - start) / 1000).toFixed(0)} s`)
  }
  caches.push(c)
}
if (caches.some((c) => c === null)) {
  log(`not scored: no cache yet for ${SMD_MACHINES.filter((_, i) => !caches[i]).join(', ')}`)
  process.exit(0)
}
const complete = (key: string) => caches.every((c) => c!.series.every((s) => key in s.runs))
const SCORED = [...DETECTORS, 'random'].filter((d) => PROFILE_NAMES.every((p) => jobOf[d]![p].every(complete)))
const NOT_RUN = [...DETECTORS, 'random'].filter((d) => !SCORED.includes(d))
const scoredJobs = [...jobs.keys()].filter(complete)
log(`detectors done in ${((performance.now() - t0) / 1000).toFixed(0)} s; scoring ${SCORED.join(', ')}${NOT_RUN.length ? `; not run: ${NOT_RUN.join(', ')}` : ''}`)

// ───────────────────────────── labels ─────────────────────────────

const labelsOnly = SMD_MACHINES.map((name) => loadMachine(name))
const agreement = CONVENTIONS.map((c) => ({ c, ...conventionAgreement(labelsOnly, c) }))
agreement.sort((a, b) => b.agree - a.agree)
const conv: Convention = agreement[0]!.c
const machineSegs = labelsOnly.map((m) => runsOf(m.label))
const interpRanges = labelsOnly.reduce((a, m) => a + m.interp.length, 0)

// ───────────────────────────── score ─────────────────────────────

const profiles = loadProfiles()
const nM = SMD_MACHINES.length
type Counts = Omit<EventCounts, 'delays'> & { delays: number[] }
const zeroCounts = (): Counts => ({ segments: 0, detected: 0, onsets: 0, trueOnsets: 0, ignored: 0, delays: [] })
const add = (a: Counts, b: EventCounts) => { a.segments += b.segments; a.detected += b.detected; a.onsets += b.onsets; a.trueOnsets += b.trueOnsets; a.ignored += b.ignored; a.delays.push(...b.delays) }
interface PerMachine {
  windows: number
  segments: number
  testDays: number
  nul: Record<ProfileName, number>
  nulStrict: Record<ProfileName, number>
  raw: Record<string, Record<ProfileName, number>>
  rawStrict: Record<string, Record<ProfileName, number>>
  event: Record<string, Counts>
  /** NAB-window view: windows with an onset, onsets in windows, onsets on scored rows. */
  win: Record<string, { detected: number; inWindows: number; scoredOnsets: number }>
  machine: Record<string, Counts>
}
const per: PerMachine[] = []
const periods: Record<string, number> = {}
let seriesCount = 0, excludedCount = 0
const profileArr = PROFILE_NAMES.map((p) => [p, profiles[p]] as [ProfileName, CostMatrix])
for (let mi = 0; mi < nM; mi++) {
  const c = caches[mi]!
  const m = labelsOnly[mi]!
  const pm: PerMachine = {
    windows: 0, segments: 0, testDays: (c.nTest * P.dataset.stepMs) / 86_400_000,
    nul: Object.fromEntries(PROFILE_NAMES.map((p) => [p, 0])) as Record<ProfileName, number>,
    nulStrict: Object.fromEntries(PROFILE_NAMES.map((p) => [p, 0])) as Record<ProfileName, number>,
    raw: {}, rawStrict: {}, event: {}, win: {}, machine: {},
  }
  for (const k of scoredJobs) {
    pm.raw[k] = Object.fromEntries(PROFILE_NAMES.map((p) => [p, 0])) as Record<ProfileName, number>
    pm.rawStrict[k] = Object.fromEntries(PROFILE_NAMES.map((p) => [p, 0])) as Record<ProfileName, number>
    pm.event[k] = zeroCounts()
    pm.win[k] = { detected: 0, inWindows: 0, scoredOnsets: 0 }
  }
  excludedCount += c.excluded.length
  for (const s of c.series) {
    seriesCount++
    const label = s.periodMs === null ? 'none' : `${s.periodMs / 3_600_000} h`
    periods[label] = (periods[label] ?? 0) + 1
    const segs = seriesSegments(m.interp, s.dim, conv, c.nTest)
    const windows = nabWindows(segs, c.nTest, P.windows.fraction)
    const dc = dontCareSpans(machineSegs[mi]!, segs, windows, TOL, c.nTest)
    const rows = seriesRows(c.nTest, windows, dc)
    const rowsStrict = seriesRows(c.nTest, windows, [])
    pm.windows += windows.length
    pm.segments += segs.length
    for (const [p, cm] of profileArr) {
      pm.nul[p] += nullScore([{ rows }], cm)
      pm.nulStrict[p] += nullScore([{ rows: rowsStrict }], cm)
    }
    for (const k of scoredJobs) {
      const on = onsetsOf(s.runs[k]!)
      const sig = onsetSignal(c.nTest, on)
      for (const [p, cm] of profileArr) {
        pm.raw[k]![p] += scoreAt([{ rows, scores: sig }], cm, 0.5).score
        pm.rawStrict[k]![p] += scoreAt([{ rows: rowsStrict, scores: sig }], cm, 0.5).score
      }
      add(pm.event[k]!, eventCounts(segs, on, TOL, dc))
      const w = pm.win[k]!
      const hit = new Set<number>()
      for (const i of on) {
        if (rows.window[i] === -2) continue
        w.scoredOnsets++
        const wi = spanIndex(windows, i)
        if (wi >= 0) { w.inWindows++; hit.add(wi) }
      }
      w.detected += hit.size
    }
  }
  for (const k of scoredJobs) {
    const union = unionRuns(c.series.map((s) => s.runs[k]!))
    const mc = zeroCounts()
    add(mc, eventCounts(machineSegs[mi]!, onsetsOf(union), TOL))
    pm.machine[k] = mc
  }
  per.push(pm)
}

// ───────────────────────────── aggregate ─────────────────────────────

const ALL = new Float64Array(nM).fill(1)
/** Normalised score of a detector in a profile (random: mean of its seeds' raw scores). */
function scoreW(det: string, p: ProfileName, w: ArrayLike<number>, strict = false): number {
  const keys = jobOf[det]![p]
  const raw = per.map((pm) => keys.reduce((a, k) => a + (strict ? pm.rawStrict : pm.raw)[k]![p], 0) / keys.length)
  return weightedNormalised(w, raw, per.map((pm) => (strict ? pm.nulStrict : pm.nul)[p]), per.map((pm) => pm.windows), profiles[p].tpWeight)
}
function countsW(det: string, p: ProfileName, w: ArrayLike<number>, view: 'event' | 'machine'): { segments: number; detected: number; onsets: number; trueOnsets: number } {
  const keys = jobOf[det]![p]
  const c = { segments: 0, detected: 0, onsets: 0, trueOnsets: 0 }
  for (let j = 0; j < nM; j++) for (const k of keys) {
    const e = per[j]![view][k]!
    c.segments += (w[j]! * e.segments) / keys.length
    c.detected += (w[j]! * e.detected) / keys.length
    c.onsets += (w[j]! * e.onsets) / keys.length
    c.trueOnsets += (w[j]! * e.trueOnsets) / keys.length
  }
  return c
}
const f1W = (det: string, p: ProfileName, w: ArrayLike<number>, view: 'event' | 'machine' = 'event') => prf(countsW(det, p, w, view)).f1
const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]! : NaN)

const ORDER = ['threshold', 'ewma', 'robust_z', 'seasonal', 'stl', 'cusum', 'pelt', 'robust_z_posthoc', 'seasonal_posthoc', 'robust_z_quantile', 'seasonal_quantile', 'random'].filter((d) => SCORED.includes(d))
const B = P.bootstrap
interface Row {
  detector: string
  config: Record<ProfileName, string>
  score: Record<ProfileName, number>
  scoreStrict: Record<ProfileName, number>
  nabHeldOut: Record<ProfileName, number> | null
  nabInSample: Record<ProfileName, number>
  windowRecall: number
  windowEventPrecision: number
  event: { precision: number; recall: number; f1: number; onsets: number; medianDelay: number }
  eventLowFP: { precision: number; recall: number; f1: number }
  machine: { precision: number; recall: number; f1: number; falsePerMachineDay: number }
  machineLowFP: { precision: number; recall: number; f1: number; falsePerMachineDay: number }
  vsEwma: Record<string, { diff: number; interval: [number, number] }>
  vsThreshold: Record<string, { diff: number; interval: [number, number] }>
  cpuMsPer1000: number | null
}
const testDays = per.reduce((a, pm) => a + pm.testDays, 0)
const totalPoints = caches.reduce((a, c) => a + c!.points, 0)
const rowsOut: Row[] = []
const diffs = (det: string, base: string) => {
  const out: Record<string, { diff: number; interval: [number, number] }> = {}
  if (det === base || !SCORED.includes(base)) return out
  for (const p of PROFILE_NAMES) {
    const stat = (w: ArrayLike<number>) => scoreW(det, p, w) - scoreW(base, p, w)
    out[p] = { diff: stat(ALL), interval: bootstrapInterval(nM, stat, B.resamples, B.seed, B.interval) }
  }
  const f1 = (w: ArrayLike<number>) => f1W(det, 'standard', w) - f1W(base, 'standard', w)
  out.eventF1 = { diff: f1(ALL), interval: bootstrapInterval(nM, f1, B.resamples, B.seed, B.interval) }
  return out
}
for (const det of ORDER) {
  const std = jobOf[det]!.standard
  const ev = countsW(det, 'standard', ALL, 'event')
  const mStd = countsW(det, 'standard', ALL, 'machine')
  const mFP = countsW(det, 'reward_low_FP_rate', ALL, 'machine')
  const win = std.reduce((a, k) => ({ d: a.d + per.reduce((x, pm) => x + pm.win[k]!.detected, 0), i: a.i + per.reduce((x, pm) => x + pm.win[k]!.inWindows, 0), s: a.s + per.reduce((x, pm) => x + pm.win[k]!.scoredOnsets, 0) }), { d: 0, i: 0, s: 0 })
  const totalWindows = per.reduce((a, pm) => a + pm.windows, 0)
  // CPU of the runs this detector's standard configuration took part in (a robust z group's call is shared by its configurations)
  const cpu = det === 'random' ? null : caches.reduce((a, c) => a + Object.entries(c!.cpuMs).filter(([k]) => k.split(' + ').includes(std[0]!)).reduce((x, [, v]) => x + v, 0), 0)
  const heldName = det === 'random' ? 'random (NAB published, as onsets)' : det
  rowsOut.push({
    detector: det,
    config: Object.fromEntries(PROFILE_NAMES.map((p) => [p, frozen.detectors[det]![p].label])) as Record<ProfileName, string>,
    score: Object.fromEntries(PROFILE_NAMES.map((p) => [p, scoreW(det, p, ALL)])) as Record<ProfileName, number>,
    scoreStrict: Object.fromEntries(PROFILE_NAMES.map((p) => [p, scoreW(det, p, ALL, true)])) as Record<ProfileName, number>,
    nabHeldOut: frozen.nabHeldOut?.[heldName] ?? null,
    nabInSample: Object.fromEntries(PROFILE_NAMES.map((p) => [p, frozen.detectors[det]![p].nabInSample])) as Record<ProfileName, number>,
    windowRecall: win.d / std.length / totalWindows,
    windowEventPrecision: win.s ? win.i / win.s : 0,
    event: { ...prf(ev), onsets: ev.onsets, medianDelay: median(per.flatMap((pm) => pm.event[std[0]!]!.delays)) },
    eventLowFP: prf(countsW(det, 'reward_low_FP_rate', ALL, 'event')),
    machine: { ...prf(mStd), falsePerMachineDay: (mStd.onsets - mStd.trueOnsets) / testDays },
    machineLowFP: { ...prf(mFP), falsePerMachineDay: (mFP.onsets - mFP.trueOnsets) / testDays },
    vsEwma: diffs(det, 'ewma'),
    vsThreshold: diffs(det, 'threshold'),
    cpuMsPer1000: cpu === null ? null : (1000 * cpu) / totalPoints,
  })
  log(`${det}: ${PROFILE_NAMES.map((p) => rowsOut[rowsOut.length - 1]!.score[p].toFixed(1)).join(' / ')}; event F1 ${rowsOut[rowsOut.length - 1]!.event.f1.toFixed(3)}`)
}

// ───────────────────────────── hypotheses and decision ─────────────────────────────

const R = Object.fromEntries(rowsOut.map((r) => [r.detector, r])) as Record<string, Row>
const s = (d: string, p: ProfileName = 'standard') => R[d]!.score[p]
const has = (...ds: string[]) => ds.every((d) => d in R)
const H = (id: string, i: number, ds: string[], held: () => boolean, detail: () => string) =>
  ({ id, text: P.hypotheses[i]!, held: has(...ds) ? held() : null, detail: has(...ds) ? detail() : `not run: ${ds.filter((d) => !(d in R)).join(', ')}` })
const hyp: { id: string; text: string; held: boolean | null; detail: string }[] = [
  H('H1', 0, ['robust_z_quantile', 'ewma'], () => s('robust_z_quantile') > s('ewma'), () => `${s('robust_z_quantile').toFixed(1)} vs ${s('ewma').toFixed(1)}`),
  H('H2', 1, ['seasonal_quantile', 'ewma'], () => s('seasonal_quantile') > s('ewma'), () => `${s('seasonal_quantile').toFixed(1)} vs ${s('ewma').toFixed(1)}`),
  H('H3', 2, ['ewma', 'threshold'], () => s('ewma') > s('threshold'), () => `${s('ewma').toFixed(1)} vs ${s('threshold').toFixed(1)}`),
  H('H4', 3, ['ewma', 'threshold'], () => s('threshold', 'reward_low_FP_rate') > s('ewma', 'reward_low_FP_rate'), () => `${s('threshold', 'reward_low_FP_rate').toFixed(1)} vs ${s('ewma', 'reward_low_FP_rate').toFixed(1)}`),
  H('H5', 4, ['robust_z', 'seasonal', 'threshold'], () => s('robust_z') < s('threshold') && s('seasonal') < s('threshold'), () => `${s('robust_z').toFixed(1)}, ${s('seasonal').toFixed(1)} vs ${s('threshold').toFixed(1)}`),
  H('H6', 5, ['cusum', 'stl', 'pelt', 'threshold'], () => ['cusum', 'stl', 'pelt'].every((d) => s(d) < s('threshold')), () => `${['cusum', 'stl', 'pelt'].map((d) => s(d).toFixed(1)).join(', ')} vs ${s('threshold').toFixed(1)}`),
  H('H7', 6, ['robust_z_quantile', 'robust_z_posthoc'], () => s('robust_z_quantile') > s('robust_z_posthoc'), () => `${s('robust_z_quantile').toFixed(1)} vs ${s('robust_z_posthoc').toFixed(1)}`),
  H('H8', 7, ['threshold', 'random'], () => s('threshold') > s('random'), () => `${s('threshold').toFixed(1)} vs ${s('random').toFixed(1)}`),
]
function decide(det: string): { verdict: string; why: string } {
  if (!has(det, 'ewma', 'threshold')) return { verdict: 'NOT RUN', why: 'needs the detector, EWMA and the threshold' }
  const r = R[det]!
  const beatsE = r.score.standard > s('ewma')
  const beatsT = r.score.standard > s('threshold')
  const f1 = r.event.f1 > R.ewma!.event.f1
  const ci = r.vsEwma.standard!.interval
  const why = `score ${r.score.standard.toFixed(1)} vs EWMA ${s('ewma').toFixed(1)} and threshold ${s('threshold').toFixed(1)}; event F1 ${r.event.f1.toFixed(3)} vs EWMA ${R.ewma!.event.f1.toFixed(3)}; score − EWMA ${r.vsEwma.standard!.diff.toFixed(1)}, 95% interval [${ci[0].toFixed(1)}, ${ci[1].toFixed(1)}]`
  if (beatsE && beatsT && f1 && ci[0] > 0) return { verdict: 'GENERALISES', why }
  if (beatsE && beatsT && f1) return { verdict: 'NOT CONFIRMED', why }
  return { verdict: 'DOES NOT GENERALISE', why }
}
const decisions = { robust_z_quantile: decide('robust_z_quantile'), seasonal_quantile: decide('seasonal_quantile') }

const results = {
  frozenAt: frozen.frozenAt, frozenSha256: frozenSha, smdFetchedAt: fetchedAt, scoredAt: new Date().toISOString(),
  scorerSha256: { 'bench/smd.ts': sha(readFileSync(join(HERE, 'smd.ts'))), 'bench/smd-run.ts': sha(readFileSync(join(HERE, 'smd-run.ts'))) },
  corpus: { machines: nM, series: seriesCount, excludedConstant: excludedCount, points: totalPoints, testDays, windows: per.reduce((a, pm) => a + pm.windows, 0), segments: per.reduce((a, pm) => a + pm.segments, 0), machineSegments: machineSegs.reduce((a, x) => a + x.length, 0), interpretationRanges: interpRanges, seasonality: periods },
  interpretationConvention: { chosen: conv, agreement: agreement.map((a) => ({ ...a.c, agree: a.agree, rows: a.rows, fraction: a.agree / a.rows })) },
  notRun: NOT_RUN,
  verifiedGroupedRuns: caches.reduce((a, c) => a + (c!.verified?.length ?? 0), 0),
  rows: rowsOut,
  hypotheses: hyp,
  decisions,
  perMachine: SMD_MACHINES.map((name, j) => ({ machine: name, windows: per[j]!.windows, segments: per[j]!.segments, standard: Object.fromEntries(ORDER.map((d) => [d, scoreW(d, 'standard', ALL.map((_, i) => (i === j ? 1 : 0)))])) })),
  elapsedSeconds: (performance.now() - t0) / 1000,
}
writeFileSync(join(OUT, 'smd-results.json'), JSON.stringify(results, null, 1))

// ───────────────────────────── tables ─────────────────────────────

const f1 = (x: number | undefined | null) => (x === undefined || x === null || !Number.isFinite(x) ? '–' : x.toFixed(1))
const pct = (x: number) => `${(100 * x).toFixed(0)}%`
const iv = (d: { diff: number; interval: [number, number] } | undefined) => (d ? `${d.diff >= 0 ? '+' : ''}${d.diff.toFixed(1)} [${d.interval[0].toFixed(1)}, ${d.interval[1].toFixed(1)}]` : '–')
const ivF = (d: { diff: number; interval: [number, number] } | undefined) => (d ? `${d.diff >= 0 ? '+' : ''}${d.diff.toFixed(3)} [${d.interval[0].toFixed(3)}, ${d.interval[1].toFixed(3)}]` : '–')
const L: string[] = []
const rankStd = [...rowsOut].sort((a, b) => b.score.standard - a.score.standard).map((r) => r.detector)
L.push(`### SMD (${results.corpus.series} series on ${nM} machines; ${results.corpus.windows} windows from ${results.corpus.segments} labelled segments; frozen ${frozen.frozenAt}, fetched ${fetchedAt})`, '')
L.push('| detector | SMD standard | SMD low FP | SMD low FN | NAB held-out (std / low FP / low FN) | rank (std) | vs EWMA, std [95%] | vs threshold, std [95%] |', '|---|---|---|---|---|---|---|---|')
for (const r of rowsOut) L.push(`| ${r.detector} | ${f1(r.score.standard)} | ${f1(r.score.reward_low_FP_rate)} | ${f1(r.score.reward_low_FN_rate)} | ${r.nabHeldOut ? `${f1(r.nabHeldOut.standard)} / ${f1(r.nabHeldOut.reward_low_FP_rate)} / ${f1(r.nabHeldOut.reward_low_FN_rate)}` : '–'} | ${rankStd.indexOf(r.detector) + 1} | ${iv(r.vsEwma.standard)} | ${iv(r.vsThreshold.standard)} |`)
L.push('', '| detector | config (standard) | window recall | event precision (NAB windows) | event P / R / F1 (±15 min) | F1 vs EWMA [95%] | median delay (min) | machine view P / R / F1 | false onsets per machine-day | low-FP config: machine P / R, false per machine-day |', '|---|---|---|---|---|---|---|---|---|---|')
for (const r of rowsOut) L.push(`| ${r.detector} | ${r.config.standard} | ${pct(r.windowRecall)} | ${pct(r.windowEventPrecision)} | ${pct(r.event.precision)} / ${pct(r.event.recall)} / ${r.event.f1.toFixed(3)} | ${ivF(r.vsEwma.eventF1)} | ${r.event.medianDelay} | ${pct(r.machine.precision)} / ${pct(r.machine.recall)} / ${r.machine.f1.toFixed(3)} | ${r.machine.falsePerMachineDay.toFixed(1)} | ${pct(r.machineLowFP.precision)} / ${pct(r.machineLowFP.recall)}, ${r.machineLowFP.falsePerMachineDay.toFixed(1)} |`)
L.push('', '| detector | low FP vs EWMA [95%] | low FP vs threshold [95%] | strict (no don\'t-care) std / low FP / low FN | CPU ms per 1,000 points |', '|---|---|---|---|---|')
for (const r of rowsOut) L.push(`| ${r.detector} | ${iv(r.vsEwma.reward_low_FP_rate)} | ${iv(r.vsThreshold.reward_low_FP_rate)} | ${f1(r.scoreStrict.standard)} / ${f1(r.scoreStrict.reward_low_FP_rate)} / ${f1(r.scoreStrict.reward_low_FN_rate)} | ${r.cpuMsPer1000 === null ? '–' : r.cpuMsPer1000.toFixed(2)} |`)
L.push('', '| hypothesis (from NAB) | held on SMD | numbers |', '|---|---|---|')
for (const h of hyp) L.push(`| ${h.text} | ${h.held === null ? 'not run' : h.held ? 'yes' : '**no**'} | ${h.detail} |`)
L.push('', ...Object.entries(decisions).map(([d, v]) => `- **${d}: ${v.verdict}** (${v.why})`))
L.push('', `Interpretation ranges: ${conv.base}-based, end ${conv.endInclusive ? 'inclusive' : 'exclusive'} (agrees with test_label on ${pct(agreement[0]!.agree / agreement[0]!.rows)} of rows; next best ${pct(agreement[1]!.agree / agreement[1]!.rows)}). Seasonality detected on the history: ${Object.entries(periods).map(([k, v]) => `${k} ${v}`).join(', ')}. Constant series excluded: ${excludedCount}.${NOT_RUN.length ? ` Not run: ${NOT_RUN.join(', ')}.` : ''}`)
console.log(L.join('\n'))
writeFileSync(join(OUT, 'smd-results.md'), L.join('\n') + '\n')
