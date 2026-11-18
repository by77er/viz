/**
 * Numenta Anomaly Benchmark: corpus loader and a line-by-line port of NAB's scorer
 * (nab/sweeper.py `calcSweepScore`, `calcScoreByThreshold`; nab/optimizer.py
 * `optimizeThreshold`; nab/scorer.py `scoreCorpus`; nab/runner.py `normalize`), fetched from
 * github.com/numenta/NAB master on 2026-11-18. Comments quote the Python they port.
 *
 * Node only (reads files). Not part of the library.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const NAB_DIR = new URL('./data/nab/', import.meta.url).pathname

export interface CostMatrix { tpWeight: number; fnWeight: number; fpWeight: number }
export type ProfileName = 'standard' | 'reward_low_FP_rate' | 'reward_low_FN_rate'
export const PROFILE_NAMES: ProfileName[] = ['standard', 'reward_low_FP_rate', 'reward_low_FN_rate']

export interface NabFile {
  /** e.g. "realKnownCause/nyc_taxi.csv" */
  path: string
  category: string
  /** Timestamp strings exactly as in the CSV. */
  stamps: string[]
  ts: Float64Array
  values: Float64Array
  /** [startIndex, endIndex] inclusive, from combined_windows.json. */
  windows: [number, number][]
  /** Indices of the labelled anomaly points (combined_labels.json), for detection delay. */
  labels: number[]
}

/** "2014-04-10 07:15:00" or "2014-04-10 07:15:00.000000" → canonical "2014-04-10 07:15:00". */
const canon = (s: string) => s.trim().replace(/\.\d+$/, '')

function parseStamp(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s)
  if (!m) return NaN
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)
}

export function loadProfiles(dir = NAB_DIR): Record<ProfileName, CostMatrix> {
  const raw = JSON.parse(readFileSync(join(dir, 'config/profiles.json'), 'utf8')) as Record<string, { CostMatrix: CostMatrix }>
  const out = {} as Record<ProfileName, CostMatrix>
  for (const p of PROFILE_NAMES) out[p] = raw[p]!.CostMatrix
  return out
}

export function loadCorpus(dir = NAB_DIR): NabFile[] {
  if (!existsSync(join(dir, 'labels/combined_windows.json'))) {
    throw new Error(`NAB data not found under ${dir}; run: bash bench/fetch-nab.sh --results`)
  }
  const windows = JSON.parse(readFileSync(join(dir, 'labels/combined_windows.json'), 'utf8')) as Record<string, [string, string][]>
  const labels = JSON.parse(readFileSync(join(dir, 'labels/combined_labels.json'), 'utf8')) as Record<string, string[]>
  const files: NabFile[] = []
  for (const path of Object.keys(windows).sort()) {
    const text = readFileSync(join(dir, 'data', path), 'utf8')
    const lines = text.split('\n')
    const stamps: string[] = []
    const vals: number[] = []
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!.trim()
      if (!line) continue
      const c = line.indexOf(',')
      stamps.push(canon(line.slice(0, c)))
      vals.push(Number(line.slice(c + 1)))
    }
    const index = new Map<string, number>()
    stamps.forEach((s, i) => { if (!index.has(s)) index.set(s, i) }) // Python list.index: first occurrence
    const w: [number, number][] = windows[path]!.map(([a, b]) => {
      const s = index.get(canon(a)), e = index.get(canon(b))
      if (s === undefined || e === undefined) throw new Error(`window timestamp not in ${path}`)
      return [s, e]
    })
    const l = (labels[path] ?? []).map((s) => index.get(canon(s))).filter((x): x is number => x !== undefined)
    files.push({
      path,
      category: path.split('/')[0]!,
      stamps,
      ts: Float64Array.from(stamps, parseStamp),
      values: Float64Array.from(vals),
      windows: w,
      labels: l,
    })
  }
  return files
}

/** Published per-row anomaly scores of one of NAB's own detectors (fetched with --results). */
export function loadPublishedScores(detector: string, file: NabFile, dir = NAB_DIR): Float64Array {
  const p = join(dir, 'results', detector, file.path.replace(/\.csv$/, '.scores'))
  const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '')
  if (lines.length !== file.stamps.length) throw new Error(`${p}: ${lines.length} rows, data has ${file.stamps.length}`)
  return Float64Array.from(lines, Number)
}

export function publishedFinalResults(dir = NAB_DIR): Record<string, Record<ProfileName, number>> {
  return JSON.parse(readFileSync(join(dir, 'results/final_results.json'), 'utf8'))
}

// ───────────────────────────── sweeper.py ─────────────────────────────

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))

/** sweeper.py scaledSigmoid */
export function scaledSigmoid(rel: number): number {
  if (rel > 3.0) return -1.0 // "FP well behind window"
  return 2 * sigmoid(-5 * rel) - 1.0
}

/** runner.py: probationaryPercent = 0.15 */
export const PROBATION_PERCENT = 0.15

/** sweeper.py _getProbationaryLength: min(floor(p * numRows), p * 5000) */
export function probationaryLength(n: number, p = PROBATION_PERCENT): number {
  return Math.min(Math.floor(p * n), p * 5000)
}

/**
 * Per-row scoring facts for one file, independent of the cost matrix:
 *   window  ≥ 0: index of the window the row is in; -1: outside; -2: probationary (not scored)
 *   unweighted: scaledSigmoid value the row would earn if detected (TP part or FP part)
 */
export interface SweepRows {
  window: Int32Array
  unweighted: Float64Array
  /** Number of windows; window ids are file-local. */
  nWindows: number
}

/** sweeper.py calcSweepScore, without the weights (applied in `weighted`). */
export function sweepRows(file: NabFile): SweepRows {
  const n = file.stamps.length
  const window = new Int32Array(n)
  const unweighted = new Float64Array(n)
  const prob = probationaryLength(n)
  let cur = -1 // current window id
  let curRight = -1
  let curWidth = 0
  let prevRight: number | null = null
  let prevWidth = 0
  let next = 0 // next window to enter
  for (let i = 0; i < n; i++) {
    // "if windowLimits and curTime == windowLimits[0][0]"
    if (next < file.windows.length && file.stamps[i] === file.stamps[file.windows[next]![0]]) {
      cur = next
      curRight = file.windows[next]![1]
      curWidth = curRight - file.windows[next]![0] + 1
      next++
    }
    let u: number
    if (cur >= 0) {
      // positionInWindow = -(curWindowRightIndex - i + 1) / curWindowWidth
      u = scaledSigmoid(-(curRight - i + 1) / curWidth)
    } else if (prevRight === null) {
      u = -1.0
    } else {
      // positionPastWindow = abs(prevWindowRightIndex - i) / float(prevWindowWidth - 1)
      u = scaledSigmoid(Math.abs(prevRight - i) / (prevWidth - 1))
    }
    unweighted[i] = u
    window[i] = i >= prob ? cur : -2
    // "If at right-edge of window, exit window" (by timestamp equality, as in Python)
    if (cur >= 0 && file.stamps[i] === file.stamps[curRight]) {
      prevRight = i
      prevWidth = curWidth
      cur = -1
    }
  }
  return { window, unweighted, nWindows: file.windows.length }
}

const MAX_TP = scaledSigmoid(-1.0)

/** Per-row weighted sweep score: TP part × tpWeight / maxTP, FP part × fpWeight. */
export function weighted(rows: SweepRows, cm: CostMatrix): Float64Array {
  const out = new Float64Array(rows.unweighted.length)
  for (let i = 0; i < out.length; i++) {
    const w = rows.window[i]!
    out[i] = w >= 0 ? (rows.unweighted[i]! * cm.tpWeight) / MAX_TP : rows.unweighted[i]! * cm.fpWeight
  }
  return out
}

export interface Tally { score: number; tp: number; fp: number; fn: number; tn: number }

/**
 * Score of a set of files at one threshold: a row is a detection when its anomaly score is
 * ≥ threshold (that is what `calcScoreByThreshold` + `scoreDataSet`'s row matching compute).
 * Per window: the best detected row, or -fnWeight. Plus the sum of FP rows.
 * Counts are row counts, as in NAB.
 */
export function scoreAt(entries: { rows: SweepRows; scores: ArrayLike<number> }[], cm: CostMatrix, threshold: number): Tally {
  let score = 0, tp = 0, fp = 0, fn = 0, tn = 0
  for (const { rows, scores } of entries) {
    const w = weighted(rows, cm)
    const best = new Float64Array(rows.nWindows).fill(NaN) // NaN = window has no scorable rows
    for (let i = 0; i < w.length; i++) {
      const win = rows.window[i]!
      if (win === -2) continue
      if (win >= 0 && Number.isNaN(best[win]!)) best[win] = -cm.fnWeight
      const det = scores[i]! >= threshold
      if (win >= 0) {
        if (det) { tp++; if (w[i]! > best[win]!) best[win] = w[i]! } else fn++
      } else if (det) { fp++; score += w[i]! } else tn++
    }
    for (const b of best) if (!Number.isNaN(b)) score += b
  }
  return { score, tp, fp, fn, tn }
}

/**
 * optimizer.py optimizeThreshold over the given files: sweep every distinct score from the
 * highest down (starting at 1.1, "all points skipped"), keep the threshold with the highest
 * total. Ties go to the higher threshold (Python's stable sort over a descending list).
 */
export function optimizeThreshold(entries: { rows: SweepRows; scores: ArrayLike<number> }[], cm: CostMatrix): { threshold: number; score: number } {
  // gather scorable rows
  type Row = { s: number; w: number; win: number }
  const rows: Row[] = []
  const parts: number[] = [] // per global window: current part
  let base = 0
  for (const { rows: r, scores } of entries) {
    const w = weighted(r, cm)
    const seen = new Int32Array(r.nWindows).fill(-1)
    for (let i = 0; i < w.length; i++) {
      const win = r.window[i]!
      if (win === -2) continue
      let g = -1
      if (win >= 0) {
        if (seen[win] === -1) { seen[win] = parts.length; parts.push(-cm.fnWeight) }
        g = seen[win]!
      }
      rows.push({ s: scores[i]!, w: w[i]!, win: g })
    }
    void base
  }
  rows.sort((a, b) => b.s - a.s)
  let fpSum = 0
  let total = parts.reduce((a, b) => a + b, 0)
  let bestScore = total
  let bestThreshold = 1.1
  let curThreshold = 1.1
  for (const r of rows) {
    if (r.s !== curThreshold) {
      if (total > bestScore) { bestScore = total; bestThreshold = curThreshold }
      curThreshold = r.s
    }
    if (r.win < 0) { fpSum += r.w; total += r.w } else if (r.w > parts[r.win]!) { total += r.w - parts[r.win]!; parts[r.win] = r.w }
  }
  if (total > bestScore) { bestScore = total; bestThreshold = curThreshold }
  void fpSum
  return { threshold: bestThreshold, score: bestScore }
}

/** runner.py normalize: 100 * (score - null) / (perfect - null), perfect = #windows * tpWeight. */
export function normalize(raw: number, nullScore: number, nWindows: number, cm: CostMatrix): number {
  const perfect = nWindows * cm.tpWeight
  return (100 * (raw - nullScore)) / (perfect - nullScore)
}

/** The null detector's score: no detections at all, i.e. every scorable window is a miss. */
export function nullScore(entries: { rows: SweepRows }[], cm: CostMatrix): number {
  return scoreAt(entries.map((e) => ({ rows: e.rows, scores: new Float64Array(e.rows.window.length) })), cm, 1.1).score
}

// ───────────────────────────── window metrics (not NAB's) ─────────────────────────────

export interface WindowMetrics {
  windows: number
  detectedWindows: number
  /** Alarm events: maximal runs of consecutive detected rows (outside probation). */
  events: number
  eventsInWindows: number
  /** Window recall = detectedWindows / windows; event precision = eventsInWindows / events. */
  recall: number
  precision: number
  /** Rows from the window start to the first detection, per detected window. */
  delaysFromStart: number[]
  /** Rows from the labelled anomaly to the first detection in its window (negative = early). */
  delaysFromLabel: number[]
}

export function windowMetrics(files: { file: NabFile; rows: SweepRows; detections: ArrayLike<boolean | number> }[]): WindowMetrics {
  let windows = 0, detectedWindows = 0, events = 0, eventsInWindows = 0
  const delaysFromStart: number[] = []
  const delaysFromLabel: number[] = []
  for (const { file, rows, detections } of files) {
    const det = (i: number) => Boolean(detections[i])
    for (let wi = 0; wi < file.windows.length; wi++) {
      const [s, e] = file.windows[wi]!
      // only windows that are scorable (some row after probation)
      let scorable = false
      for (let i = s; i <= e; i++) if (rows.window[i] === wi) { scorable = true; break }
      if (!scorable) continue
      windows++
      let first = -1
      for (let i = s; i <= e; i++) if (rows.window[i] === wi && det(i)) { first = i; break }
      if (first >= 0) {
        detectedWindows++
        delaysFromStart.push(first - s)
        const label = file.labels.find((l) => l >= s && l <= e)
        if (label !== undefined) delaysFromLabel.push(first - label)
      }
    }
    let inRun = false
    let runInWindow = false
    for (let i = 0; i <= rows.window.length; i++) {
      const d = i < rows.window.length && rows.window[i] !== -2 && det(i)
      if (d) {
        if (!inRun) { inRun = true; runInWindow = false; events++ }
        if (rows.window[i]! >= 0) runInWindow = true
      } else if (inRun) {
        inRun = false
        if (runInWindow) eventsInWindows++
      }
    }
  }
  return {
    windows,
    detectedWindows,
    events,
    eventsInWindows,
    recall: windows ? detectedWindows / windows : 0,
    precision: events ? eventsInWindows / events : 0,
    delaysFromStart,
    delaysFromLabel,
  }
}
