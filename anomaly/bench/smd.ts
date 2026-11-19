/**
 * Second benchmark: SMD, the Server Machine Dataset (Su et al., KDD 2019; github.com/NetManAIOps/
 * OmniAnomaly, MIT licence), fetched at run time by bench/fetch-smd.sh into bench/data/smd/
 * (git-ignored). Loader, label handling and the scoring rules frozen in bench/smd-frozen.json
 * ("protocol"); bench/smd-run.ts runs the detectors and prints the tables.
 *
 * Scoring, per series (one machine's one dimension):
 *   - segments: the interpretation_label ranges that list the dimension;
 *   - NAB scorer (bench/nab.ts) with windows from NAB's labeler rule applied to segments
 *     (`nabWindows`), no probation inside the test half, and "don't care" spans
 *     (`dontCareSpans`) left unscored;
 *   - event precision / recall / F1 with a fixed tolerance (`eventCounts`).
 * Per machine (secondary): the union of its series' alarms against the test_label runs.
 *
 * Everything below the loader is pure and tested in test/smd-scorer.test.ts. Node only (reads
 * files). Not part of the library. This file is viz's own code (Apache-2.0); it uses NAB's scorer
 * through bench/nab.ts, whose MIT notice is in bench/LICENSE-NAB.txt.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sweepRows, type NabFile, type SweepRows } from './nab.ts'

export const SMD_DIR = new URL('./data/smd/', import.meta.url).pathname
export const SMD_MACHINES: string[] = [
  ...Array.from({ length: 8 }, (_, i) => `machine-1-${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `machine-2-${i + 1}`),
  ...Array.from({ length: 11 }, (_, i) => `machine-3-${i + 1}`),
]

/** Inclusive index range [start, end]. */
export type Span = [number, number]

/** One line of interpretation_label: "start-end:d1,d2,..." exactly as written (dimensions 1-based). */
export interface InterpRange { start: number; end: number; dims: number[] }

export interface SmdMachine {
  name: string
  nTrain: number
  nTest: number
  /** Columns: one Float64Array per dimension. */
  train: Float64Array[]
  test: Float64Array[]
  /** test_label: 1 = anomalous point. */
  label: Uint8Array
  interp: InterpRange[]
}

// ───────────────────────────── loader ─────────────────────────────

function parseColumns(text: string): Float64Array[] {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  const width = lines[0]!.split(',').length
  const cols = Array.from({ length: width }, () => new Float64Array(lines.length))
  lines.forEach((line, i) => {
    const cells = line.split(',')
    if (cells.length !== width) throw new Error(`row ${i}: ${cells.length} columns, expected ${width}`)
    for (let d = 0; d < width; d++) cols[d]![i] = Number(cells[d])
  })
  return cols
}

export function parseInterpretation(text: string): InterpRange[] {
  const out: InterpRange[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = /^(\d+)-(\d+):([\d,\s]+)$/.exec(line)
    if (!m) throw new Error(`interpretation_label line not understood: ${line}`)
    out.push({ start: Number(m[1]), end: Number(m[2]), dims: m[3]!.split(',').filter((s) => s.trim() !== '').map(Number) })
  }
  return out
}

export function loadMachine(name: string, dir = SMD_DIR): SmdMachine {
  const read = (part: string) => readFileSync(join(dir, part, `${name}.txt`), 'utf8')
  const train = parseColumns(read('train'))
  const test = parseColumns(read('test'))
  const label = Uint8Array.from(read('test_label').split('\n').filter((l) => l.trim() !== ''), (l) => (Number(l) ? 1 : 0))
  if (train.length !== test.length) throw new Error(`${name}: ${train.length} train columns, ${test.length} test columns`)
  if (label.length !== test[0]!.length) throw new Error(`${name}: ${label.length} labels, ${test[0]!.length} test rows`)
  return { name, nTrain: train[0]!.length, nTest: test[0]!.length, train, test, label, interp: parseInterpretation(read('interpretation_label')) }
}

// ───────────────────────────── spans ─────────────────────────────

/** Maximal runs of non-zero values, inclusive. */
export function runsOf(x: ArrayLike<number>): Span[] {
  const out: Span[] = []
  let s = -1
  for (let i = 0; i <= x.length; i++) {
    const on = i < x.length && x[i] !== 0
    if (on && s < 0) s = i
    else if (!on && s >= 0) { out.push([s, i - 1]); s = -1 }
  }
  return out
}

/** Sorted, with spans that share a row merged (and, if `adjacent`, spans that touch). */
export function mergeSpans(spans: Span[], adjacent = false): Span[] {
  const s = spans.filter(([a, b]) => b >= a).map(([a, b]) => [a, b] as Span).sort((x, y) => x[0] - y[0] || x[1] - y[1])
  const out: Span[] = []
  for (const sp of s) {
    const last = out[out.length - 1]
    if (last && sp[0] <= last[1] + (adjacent ? 1 : 0)) last[1] = Math.max(last[1], sp[1])
    else out.push(sp)
  }
  return out
}

/** Rows of `a` not in `b` (both merged or not; result merged). */
export function subtractSpans(a: Span[], b: Span[]): Span[] {
  const bb = mergeSpans(b)
  const out: Span[] = []
  for (const [s0, e0] of mergeSpans(a)) {
    let s = s0
    for (const [bs, be] of bb) {
      if (be < s) continue
      if (bs > e0) break
      if (bs > s) out.push([s, bs - 1])
      s = Math.max(s, be + 1)
      if (s > e0) break
    }
    if (s <= e0) out.push([s, e0])
  }
  return out
}

const clip = (spans: Span[], n: number): Span[] => spans.map(([a, b]) => [Math.max(0, a), Math.min(n - 1, b)] as Span).filter(([a, b]) => b >= a)
const widen = (spans: Span[], by: number): Span[] => spans.map(([a, b]) => [a - by, b + by] as Span)
const overlaps = (x: Span, y: Span) => x[0] <= y[1] && y[0] <= x[1]

/** Index of the span containing i, or -1 (spans merged and sorted). */
export function spanIndex(spans: Span[], i: number): number {
  let lo = 0, hi = spans.length - 1
  while (lo <= hi) {
    const m = (lo + hi) >> 1
    const [a, b] = spans[m]!
    if (i < a) hi = m - 1
    else if (i > b) lo = m + 1
    else return m
  }
  return -1
}

// ───────────────────────────── labels ─────────────────────────────

/** How interpretation_label's "start-end" maps to test rows. */
export interface Convention { base: 0 | 1; endInclusive: boolean }
export const CONVENTIONS: Convention[] = [
  { base: 0, endInclusive: true }, { base: 0, endInclusive: false }, { base: 1, endInclusive: true }, { base: 1, endInclusive: false },
]
export const toSpan = (r: InterpRange, c: Convention): Span => [r.start - c.base, (c.endInclusive ? r.end : r.end - 1) - c.base]

/** Rows on which the union of interpretation ranges equals test_label, over the given machines. */
export function conventionAgreement(machines: { label: ArrayLike<number>; interp: InterpRange[] }[], c: Convention): { agree: number; rows: number } {
  let agree = 0, rows = 0
  for (const m of machines) {
    const cover = new Uint8Array(m.label.length)
    for (const r of m.interp) {
      const [a, b] = toSpan(r, c)
      for (let i = Math.max(0, a); i <= Math.min(m.label.length - 1, b); i++) cover[i] = 1
    }
    for (let i = 0; i < cover.length; i++) if (cover[i] === (m.label[i] ? 1 : 0)) agree++
    rows += cover.length
  }
  return { agree, rows }
}

/** The segments of one dimension (1-based `dim`): interpretation ranges that list it, clipped to the test half, merged. */
export function seriesSegments(interp: InterpRange[], dim: number, c: Convention, nTest: number): Span[] {
  return mergeSpans(clip(interp.filter((r) => r.dims.includes(dim)).map((r) => toSpan(r, c)), nTest))
}

/**
 * NAB's labeler rule (nab/labeler.py applyWindows: windowLength = int(windowSize · length / #anomalies),
 * centred on each anomaly) applied to segments: w = floor(fraction · nTest / k), window =
 * [start − floor(w/2), end + floor(w/2)], clipped to [0, nTest − 1], windows sharing a row merged.
 */
export function nabWindows(segments: Span[], nTest: number, fraction: number): Span[] {
  if (segments.length === 0) return []
  const w = Math.floor((fraction * nTest) / segments.length)
  const h = Math.floor(w / 2)
  return mergeSpans(clip(segments.map(([s, e]) => [s - h, e + h] as Span), nTest))
}

/**
 * Rows of one series that are not scored: machine segments that do not list the dimension
 * (no segment of the series overlaps them), widened by `tol`, clipped, minus the series' windows.
 */
export function dontCareSpans(machineSegments: Span[], seriesSegs: Span[], windows: Span[], tol: number, nTest: number): Span[] {
  const others = machineSegments.filter((m) => !seriesSegs.some((s) => overlaps(m, s)))
  return subtractSpans(clip(widen(others, tol), nTest), windows)
}

/**
 * NAB sweep rows for a series' test half: windows as given, no probation, don't-care rows
 * marked unscored (-2, as NAB marks probation). Window rows always stay scored.
 */
export function seriesRows(nTest: number, windows: Span[], dontCare: Span[]): SweepRows {
  const file: NabFile = {
    path: 'smd', category: 'smd', stamps: Array.from({ length: nTest }, (_, i) => String(i)),
    ts: new Float64Array(0), values: new Float64Array(0), windows, labels: [],
  }
  const rows = sweepRows(file, 0)
  for (const [a, b] of dontCare) for (let i = a; i <= b; i++) if (!rows.inWindow[i]) rows.window[i] = -2
  return rows
}

// ───────────────────────────── alarms ─────────────────────────────

/**
 * Flagged runs of a series, as a flat list [s0, e0, s1, e1, ...] in test-half coordinates: e ≥ 0;
 * s = -1 for a run that began in the history (it continues into the test half; not an onset there).
 */
export function testRuns(flags: ArrayLike<number>, nHistory: number): number[] {
  const out: number[] = []
  let s = -2
  for (let i = 0; i <= flags.length; i++) {
    const on = i < flags.length && flags[i] !== 0
    if (on && s === -2) s = i
    else if (!on && s !== -2) {
      if (i - 1 >= nHistory) out.push(Math.max(s - nHistory, -1), i - 1 - nHistory)
      s = -2
    }
  }
  return out
}

/** Alarm onsets (test coordinates) of a run list. */
export const onsetsOf = (runs: number[]): number[] => runs.filter((_, j) => j % 2 === 0).filter((s) => s >= 0)

/** Union of several run lists (a run that began in the history keeps s = -1). */
export function unionRuns(lists: number[][]): number[] {
  const spans: Span[] = []
  for (const l of lists) for (let j = 0; j < l.length; j += 2) spans.push([l[j]!, l[j + 1]!])
  return mergeSpans(spans, true).flat()
}

/** 1 at each onset, for the NAB scorer (threshold 0.5). */
export function onsetSignal(nTest: number, onsets: number[]): Float64Array {
  const s = new Float64Array(nTest)
  for (const i of onsets) s[i] = 1
  return s
}

// ───────────────────────────── event metric ─────────────────────────────

export interface EventCounts {
  segments: number
  detected: number
  /** Onsets counted (outside don't-care spans, or matching a segment). */
  onsets: number
  trueOnsets: number
  /** Excluded onsets (in a don't-care span, matching no segment). */
  ignored: number
  /** First matching onset − segment start, per detected segment. */
  delays: number[]
}

/**
 * A segment is detected if an onset lies in [start − tol, end + tol]; an onset is true if it lies
 * in such a span of any segment; an onset matching none is excluded if it is in `dontCare`, false
 * otherwise. Onsets must be sorted.
 */
export function eventCounts(segments: Span[], onsets: number[], tol: number, dontCare: Span[] = []): EventCounts {
  const match = mergeSpans(widen(segments, tol))
  const dc = mergeSpans(dontCare)
  const c: EventCounts = { segments: segments.length, detected: 0, onsets: 0, trueOnsets: 0, ignored: 0, delays: [] }
  for (const [s, e] of segments) {
    // first onset ≥ s − tol
    let lo = 0, hi = onsets.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (onsets[m]! < s - tol) lo = m + 1; else hi = m }
    if (lo < onsets.length && onsets[lo]! <= e + tol) { c.detected++; c.delays.push(onsets[lo]! - s) }
  }
  for (const i of onsets) {
    if (spanIndex(match, i) >= 0) { c.onsets++; c.trueOnsets++ }
    else if (spanIndex(dc, i) >= 0) c.ignored++
    else c.onsets++
  }
  return c
}

export function prf(c: { segments: number; detected: number; onsets: number; trueOnsets: number }): { precision: number; recall: number; f1: number } {
  const precision = c.onsets ? c.trueOnsets / c.onsets : 0
  const recall = c.segments ? c.detected / c.segments : 0
  return { precision, recall, f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0 }
}

// ───────────────────────────── uncertainty ─────────────────────────────

/** mulberry32: a small seeded generator (bench only; the library has no randomness). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Percentile bootstrap over units (machines): each resample draws `units` units with
 * replacement and passes their multiplicities to `stat`. Returns the central `level` interval.
 */
export function bootstrapInterval(units: number, stat: (weights: Float64Array) => number, resamples: number, seed: number, level = 0.95): [number, number] {
  const r = rng(seed)
  const vals: number[] = []
  const w = new Float64Array(units)
  for (let b = 0; b < resamples; b++) {
    w.fill(0)
    for (let j = 0; j < units; j++) w[Math.floor(r() * units)]! += 1
    const v = stat(w)
    if (Number.isFinite(v)) vals.push(v)
  }
  vals.sort((x, y) => x - y)
  const q = (p: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(p * vals.length)))]!
  return [q((1 - level) / 2), q(1 - (1 - level) / 2)]
}

/** NAB normalisation from weighted per-unit sums: 100·(raw − null)/(windows·tp − null). */
export function weightedNormalised(w: ArrayLike<number>, raw: ArrayLike<number>, nul: ArrayLike<number>, windows: ArrayLike<number>, tpWeight: number): number {
  let r = 0, n = 0, k = 0
  for (let j = 0; j < w.length; j++) { r += w[j]! * raw[j]!; n += w[j]! * nul[j]!; k += w[j]! * windows[j]! }
  return (100 * (r - n)) / (k * tpWeight - n)
}
