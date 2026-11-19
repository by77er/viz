/**
 * The ruler's default anomaly detector (design D33, ruler/README.md part 8): the held-out NAB
 * score of robust z with the quantile spread at a FIXED window (the ruler's per-series state
 * limit sets it, not the data), k chosen per fold from the grid of anomaly/bench/adapters.ts
 * {1, 1.5, 2, 3}. The protocol is anomaly/bench/nab-run.ts's held-out protocol, copied here
 * verbatim (folds, onsets, crossValidate, normalisation); anomaly/bench/nab.ts and adapters.ts are
 * imported unchanged and checked against the hashes anomaly/bench/smd-frozen.json pinned. The
 * rows threshold, ewma and robust_z_quantile must reproduce the published held-out numbers
 * (21.84, 30.14, 44.76 standard) before a new row is trusted.
 *
 *   bash ../../../anomaly/bench/fetch-nab.sh       once (68 MB, git-ignored)
 *   node --experimental-strip-types nab-window.ts  about 1 minute; writes out/nab-window.json
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  loadCorpus, loadProfiles, sweepRows, scoreAt, normalize, nullScore, windowMetrics, PROFILE_NAMES, NAB_DIR,
  type NabFile, type ProfileName, type CostMatrix,
} from '../../../anomaly/bench/nab.ts'
import { GRIDS, context, type Config, type Ctx } from '../../../anomaly/bench/adapters.ts'
import { robustZ } from '../../../anomaly/src/index.ts'

const ANOMALY = new URL('../../../anomaly/', import.meta.url).pathname
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')
// The pinned code must be what the freeze pinned (anomaly/bench/smd-frozen.json "code").
const frozen = JSON.parse(readFileSync(ANOMALY + 'bench/smd-frozen.json', 'utf8')) as { code: Record<string, string>; nabHeldOut: Record<string, Record<ProfileName, number>> }
const pin = { 'bench/adapters.ts': sha(readFileSync(ANOMALY + 'bench/adapters.ts')), 'bench/nab.ts': sha(readFileSync(ANOMALY + 'bench/nab.ts')) }
for (const [k, v] of Object.entries(pin)) if (frozen.code[k] !== v) { console.error(`${k} differs from the freeze`); process.exit(2) }
const manifest = JSON.parse(readFileSync(ANOMALY + 'bench/nab-manifest.json', 'utf8')) as Record<string, string>
for (const [p, h] of Object.entries(manifest)) if (sha(readFileSync(`${NAB_DIR}${p.replace(/^data\//, 'data/')}`)) !== h) { console.error(`NAB file differs: ${p}`); process.exit(2) }

const files = loadCorpus()
const profiles = loadProfiles()
const rows = files.map((f) => sweepRows(f))
const ctxs = files.map(context)

// ── copied from bench/nab-run.ts ──
const fold = new Map<string, 'A' | 'B'>()
const byCat = new Map<string, NabFile[]>()
for (const f of files) byCat.set(f.category, [...(byCat.get(f.category) ?? []), f])
for (const fs of byCat.values()) fs.sort((a, b) => a.path.localeCompare(b.path)).forEach((f, i) => fold.set(f.path, i % 2 === 0 ? 'A' : 'B'))
const idxOf = (pred: (f: NabFile) => boolean) => files.map((f, i) => (pred(f) ? i : -1)).filter((i) => i >= 0)
const FOLD = { A: idxOf((f) => fold.get(f.path) === 'A'), B: idxOf((f) => fold.get(f.path) === 'B') }
const ALL = files.map((_, i) => i)
const windowsIn = (ix: number[]) => ix.reduce((a, i) => a + files[i]!.windows.length, 0)
const nullIn = (ix: number[], cm: CostMatrix) => nullScore(ix.map((i) => ({ rows: rows[i]! })), cm)
const norm = (raw: number, ix: number[], cm: CostMatrix) => normalize(raw, nullIn(ix, cm), windowsIn(ix), cm)
function onsets(flags: ArrayLike<number>): Float64Array {
  const o = new Float64Array(flags.length)
  for (let i = 0; i < flags.length; i++) if (flags[i] && !(i > 0 && flags[i - 1])) o[i] = 1
  return o
}
const entries = (ix: number[], sig: (i: number) => ArrayLike<number>) => ix.map((i) => ({ rows: rows[i]!, scores: sig(i) }))
const rawAt = (ix: number[], sig: (i: number) => ArrayLike<number>, cm: CostMatrix, t: number) => scoreAt(entries(ix, sig), cm, t).score
interface Cv { score: number; perFold: Record<'A' | 'B', { chosen: string; tuneScore: number; testRaw: number; threshold?: number }>; testSignal: Map<number, Float64Array> }
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
// ── end of copy ──

// New grids at fixed windows, built exactly as bench/adapters.ts builds robust_z_quantile (same run function).
const fromPoints = (pts: { score: number; anomalous: boolean }[]) => ({ scores: Float64Array.from(pts, (p) => p.score), flags: Uint8Array.from(pts, (p) => (p.anomalous ? 1 : 0)) })
const series = (f: NabFile) => ({ ts: f.ts, values: f.values })
const fixed = (W: number): Config[] => [1, 1.5, 2, 3].map((k) => {
  const params = { windowPoints: W, k, spread: 'quantile' }
  return { detector: `robust_z_quantile_w${W}`, label: `robust_z_quantile(windowPoints=${W},k=${k},spread=quantile)`, params, run: (f: NabFile, c: Ctx) => fromPoints(robustZ.detect(series(f), { ...params, stepMs: c.stepMs } as never).points) }
})
// Check: our fixed-window config at 1000 gives the same flags as the bench's own config with the same label.
for (const cfg of fixed(1000)) {
  const theirs = GRIDS.robust_z_quantile!.find((c) => c.label === cfg.label)!
  for (const i of [0, 17, 40]) if (sha(Buffer.from(cfg.run(files[i]!, ctxs[i]!).flags)) !== sha(Buffer.from(theirs.run(files[i]!, ctxs[i]!).flags))) { console.error(`run differs from the bench adapter: ${cfg.label}`); process.exit(2) }
}

const only = process.argv.slice(2)
const families: Record<string, Config[]> = {
  threshold: GRIDS.threshold!, ewma: GRIDS.ewma!, robust_z_quantile: GRIDS.robust_z_quantile!,
  robust_z_quantile_w1000: fixed(1000), robust_z_quantile_w1500: fixed(1500),
}
const out: Record<string, unknown> = {}
for (const [name, configs] of Object.entries(families)) {
  if (only.length && !only.includes(name)) continue
  const c0 = process.cpuUsage()
  const sigs = configs.map((cfg) => files.map((f, i) => onsets(cfg.run(f, ctxs[i] as Ctx).flags)))
  const res: Record<string, unknown> = {}
  const line: string[] = []
  for (const p of PROFILE_NAMES) {
    const cv = crossValidate(configs.map((_, j) => j), (j) => configs[j]!.label, (j, i) => sigs[j]![i]!, profiles[p], () => 0.5)
    const wm = windowMetrics(ALL.map((i) => ({ file: files[i]!, rows: rows[i]!, detections: cv.testSignal.get(i)! })))
    // in-sample (all 58 files) score of every configuration, for the record
    const inSample = Object.fromEntries(configs.map((cfg, j) => [cfg.label, norm(rawAt(ALL, (i) => sigs[j]![i]!, profiles[p], 0.5), ALL, profiles[p])]))
    res[p] = { score: cv.score, chosenA: cv.perFold.A.chosen, chosenB: cv.perFold.B.chosen, recall: wm.recall, precision: wm.precision, inSample }
    line.push(`${p} ${cv.score.toFixed(2)} (test A chose ${cv.perFold.A.chosen.replace(/.*\(|\)/g, '')}; test B chose ${cv.perFold.B.chosen.replace(/.*\(|\)/g, '')}; recall ${(100 * wm.recall).toFixed(0)}%, event precision ${(100 * wm.precision).toFixed(0)}%)`)
  }
  const u = process.cpuUsage(c0)
  out[name] = res
  const pub = frozen.nabHeldOut[name]
  console.log(`${name}: ${line.join(' | ')}${pub ? ` | published held-out ${PROFILE_NAMES.map((p) => pub[p].toFixed(2)).join(' / ')}` : ''} | ${((u.user + u.system) / 1e6).toFixed(0)} s CPU`)
}
writeFileSync(new URL(`./out/nab-window${only.length ? `.${only.join('-')}` : ''}.json`, import.meta.url), JSON.stringify(out, null, 1))
