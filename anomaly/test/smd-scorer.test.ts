/**
 * The SMD scorer (bench/smd.ts) on toy cases whose answers are worked out by hand in the
 * comments: label handling, NAB-rule windows, don't-care spans, alarm runs and onsets, the
 * event metric with its tolerance, and the machine bootstrap. NAB's scorer itself is checked
 * against NAB in nab-scorer.test.ts.
 */
import { describe, expect, it } from 'vitest'
import {
  runsOf, mergeSpans, subtractSpans, spanIndex, toSpan, conventionAgreement, seriesSegments, nabWindows, dontCareSpans,
  seriesRows, testRuns, onsetsOf, unionRuns, onsetSignal, eventCounts, prf, bootstrapInterval, weightedNormalised,
  parseInterpretation, CONVENTIONS, type Span,
} from '../bench/smd.ts'
import { scoreAt, nullScore, normalize, scaledSigmoid } from '../bench/nab.ts'

const STD = { tpWeight: 1, fnWeight: 1, fpWeight: 0.11 }

describe('spans and labels', () => {
  it('runs of non-zero values, inclusive', () => {
    expect(runsOf([0, 1, 1, 0, 1])).toEqual([[1, 2], [4, 4]])
    expect(runsOf([1, 1, 1])).toEqual([[0, 2]])
    expect(runsOf([0, 0])).toEqual([])
  })
  it('merge: spans sharing a row merge; touching spans only when asked', () => {
    expect(mergeSpans([[5, 9], [0, 2], [2, 3]])).toEqual([[0, 3], [5, 9]])
    expect(mergeSpans([[0, 3], [4, 6]])).toEqual([[0, 3], [4, 6]])
    expect(mergeSpans([[0, 3], [4, 6]], true)).toEqual([[0, 6]])
  })
  it('subtract', () => {
    expect(subtractSpans([[0, 10]], [[3, 4], [8, 12]])).toEqual([[0, 2], [5, 7]])
    expect(subtractSpans([[0, 10]], [[0, 10]])).toEqual([])
    expect(subtractSpans([[0, 3], [10, 12]], [[5, 6]])).toEqual([[0, 3], [10, 12]])
  })
  it('spanIndex', () => {
    const s: Span[] = [[0, 2], [5, 9], [20, 20]]
    expect([0, 2, 3, 5, 9, 10, 20, 21].map((i) => spanIndex(s, i))).toEqual([0, 0, -1, 1, 1, -1, 2, -1])
  })
  it('interpretation_label lines parse; anything else throws', () => {
    expect(parseInterpretation('15849-16368:1,9,10\n\n20-21:38\n')).toEqual([{ start: 15849, end: 16368, dims: [1, 9, 10] }, { start: 20, end: 21, dims: [38] }])
    expect(() => parseInterpretation('15849-16368')).toThrow()
  })
  it('the index convention that matches test_label is the one that agrees on every row', () => {
    // label rows 2..4 anomalous; the file says "3-5", i.e. 1-based and inclusive
    const machines = [{ label: [0, 0, 1, 1, 1, 0], interp: [{ start: 3, end: 5, dims: [1] }] }]
    const agree = CONVENTIONS.map((c) => conventionAgreement(machines, c).agree)
    const best = CONVENTIONS[agree.indexOf(Math.max(...agree))]!
    expect(best).toEqual({ base: 1, endInclusive: true })
    expect(conventionAgreement(machines, best)).toEqual({ agree: 6, rows: 6 })
    expect(toSpan({ start: 3, end: 5, dims: [] }, { base: 0, endInclusive: false })).toEqual([3, 4])
  })
  it('series segments: only ranges listing the dimension (1-based), clipped, merged', () => {
    const interp = [{ start: 10, end: 20, dims: [1, 2] }, { start: 15, end: 30, dims: [2] }, { start: 95, end: 120, dims: [2] }, { start: 40, end: 50, dims: [3] }]
    const c = { base: 0, endInclusive: true } as const
    expect(seriesSegments(interp, 1, c, 100)).toEqual([[10, 20]])
    expect(seriesSegments(interp, 2, c, 100)).toEqual([[10, 30], [95, 99]])
    expect(seriesSegments(interp, 4, c, 100)).toEqual([])
  })
})

describe('NAB-rule windows and don\'t-care spans', () => {
  it('width = floor(0.1 · n / k), half on each side of the segment', () => {
    // n = 1000, k = 2: w = 50, h = 25
    expect(nabWindows([[100, 109], [500, 500]], 1000, 0.1)).toEqual([[75, 134], [475, 525]])
    // k = 1: w = 100, h = 50; clipped at 0 and n − 1
    expect(nabWindows([[5, 10]], 1000, 0.1)).toEqual([[0, 60]])
    expect(nabWindows([[990, 999]], 1000, 0.1)).toEqual([[940, 999]])
    // overlapping windows merge: [75, 135] and [105, 165]
    expect(nabWindows([[100, 110], [130, 140]], 1000, 0.1)).toEqual([[75, 165]])
    expect(nabWindows([], 1000, 0.1)).toEqual([])
  })
  it('don\'t care: machine segments that do not list the dimension, widened by the tolerance, outside its windows', () => {
    const machine: Span[] = [[100, 109], [300, 310], [140, 150]]
    const series: Span[] = [[100, 105]]
    const windows: Span[] = [[75, 134]]
    // [300, 310] → [285, 325]; [140, 150] → [125, 165] minus the window → [135, 165]; [100, 109] lists it
    expect(dontCareSpans(machine, series, windows, 15, 1000)).toEqual([[135, 165], [285, 325]])
    // clipped to the test half
    expect(dontCareSpans([[2, 4]], [], [], 15, 10)).toEqual([[0, 9]])
    // a machine segment that lists the dimension is never don't-care, even where it outruns the window
    expect(dontCareSpans([[100, 140]], [[100, 105]], [[95, 110]], 5, 1000)).toEqual([])
  })
  it('rows: no probation; don\'t-care rows are not scored, window rows are', () => {
    const rows = seriesRows(100, [[60, 69]], [[20, 30], [65, 75]])
    expect([rows.window[0], rows.window[19], rows.window[20], rows.window[30], rows.window[31]]).toEqual([-1, -1, -2, -2, -1])
    expect([rows.window[65], rows.window[69], rows.window[70], rows.window[75], rows.window[76]]).toEqual([0, 0, -2, -2, -1])
    // a detection at the window's first row earns tpWeight (scaledSigmoid(−1) / maxTP = 1)
    const at = (...ix: number[]) => { const s = new Float64Array(100); for (const i of ix) s[i] = 1; return s }
    expect(scoreAt([{ rows, scores: at(60) }], STD, 0.5).score).toBeCloseTo(1, 12)
    // a detection in a don't-care span costs nothing; the same detection without the span is an FP before any window: −1 · 0.11
    expect(scoreAt([{ rows, scores: at(25, 60) }], STD, 0.5).score).toBeCloseTo(1, 12)
    expect(scoreAt([{ rows: seriesRows(100, [[60, 69]], []), scores: at(25, 60) }], STD, 0.5).score).toBeCloseTo(1 - 0.11, 12)
    // row 0 is scored (no NAB probation in the test half)
    expect(scoreAt([{ rows, scores: at(0, 60) }], STD, 0.5).score).toBeCloseTo(1 - 0.11, 12)
    // an FP 10 rows after a 10-row window: scaledSigmoid(10 / 9) · 0.11
    expect(scoreAt([{ rows: seriesRows(100, [[60, 69]], []), scores: at(79) }], STD, 0.5).score).toBeCloseTo(-1 + 0.11 * scaledSigmoid(10 / 9), 12)
    expect(nullScore([{ rows }], STD)).toBe(-1)
  })
})

describe('alarm runs and onsets', () => {
  it('runs in test coordinates; a run begun in the history is not an onset', () => {
    // full series: history = 2 rows; flags at 1-3, 6-7, 9
    const flags = [0, 1, 1, 1, 0, 0, 1, 1, 0, 1]
    expect(testRuns(flags, 2)).toEqual([-1, 1, 4, 5, 7, 7])
    expect(onsetsOf(testRuns(flags, 2))).toEqual([4, 7])
    // a run wholly in the history is dropped; one starting at the first test row is an onset at 0
    expect(testRuns([1, 0, 1, 1], 2)).toEqual([0, 1])
    expect(onsetsOf(testRuns([1, 0, 1, 1], 2))).toEqual([0])
  })
  it('machine view: the union of flags; touching runs make one alarm', () => {
    const u = unionRuns([[-1, 0, 3, 4], [2, 2, 8, 9], [5, 5]])
    expect(u).toEqual([-1, 0, 2, 5, 8, 9])
    expect(onsetsOf(u)).toEqual([2, 8])
  })
  it('onset signal', () => {
    expect(Array.from(onsetSignal(5, [1, 3]))).toEqual([0, 1, 0, 1, 0])
  })
})

describe('event metric with a fixed tolerance', () => {
  it('detected segments, true, false and ignored onsets, delays', () => {
    // segment [100,109] matches [85,124]: onsets 90, 95 true, detected with delay −10
    // segment [300,300] matches [285,315]: 316 is one row too late
    // 50, 200, 316 false; 400 in a don't-care span: ignored
    const c = eventCounts([[100, 109], [300, 300]], [50, 90, 95, 200, 316, 400], 15, [[390, 410]])
    expect(c).toEqual({ segments: 2, detected: 1, onsets: 5, trueOnsets: 2, ignored: 1, delays: [-10] })
    const m = prf(c)
    expect(m.precision).toBeCloseTo(0.4, 12)
    expect(m.recall).toBeCloseTo(0.5, 12)
    expect(m.f1).toBeCloseTo((2 * 0.4 * 0.5) / 0.9, 12)
  })
  it('the tolerance is inclusive at both ends', () => {
    expect(eventCounts([[300, 300]], [315], 15).detected).toBe(1)
    expect(eventCounts([[300, 300]], [285], 15).detected).toBe(1)
    expect(eventCounts([[300, 300]], [284, 316], 15)).toMatchObject({ detected: 0, trueOnsets: 0, onsets: 2 })
  })
  it('an onset matching a segment counts even inside a don\'t-care span', () => {
    expect(eventCounts([[100, 100]], [110], 15, [[105, 120]])).toMatchObject({ detected: 1, trueOnsets: 1, onsets: 1, ignored: 0 })
  })
  it('no alarms: precision 0, F1 0; no segments: recall 0', () => {
    expect(prf({ segments: 3, detected: 0, onsets: 0, trueOnsets: 0 })).toEqual({ precision: 0, recall: 0, f1: 0 })
    expect(prf({ segments: 0, detected: 0, onsets: 4, trueOnsets: 0 }).f1).toBe(0)
  })
})

describe('machine bootstrap', () => {
  it('weights of one equal NAB normalisation of the sums', () => {
    const raw = [0.5, -1.2, 2], nul = [-2, -1, -3], win = [2, 1, 3]
    expect(weightedNormalised([1, 1, 1], raw, nul, win, 1)).toBeCloseTo(normalize(1.3, -6, 6, STD), 12)
    expect(weightedNormalised([0, 2, 0], raw, nul, win, 1)).toBeCloseTo(normalize(-2.4, -2, 2, STD), 12)
  })
  it('resamples with replacement, seeded: a spread statistic gives a spread interval, the same twice', () => {
    const x = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    const mean = (w: ArrayLike<number>) => x.reduce((a, v, j) => a + w[j]! * v, 0) / x.length
    const a = bootstrapInterval(x.length, mean, 2000, 7)
    expect(a).toEqual(bootstrapInterval(x.length, mean, 2000, 7))
    expect(a[0]).toBeLessThan(4.5)
    expect(a[1]).toBeGreaterThan(4.5)
    // the standard error of the mean is about 0.9: a 95% interval roughly 4.5 ± 1.8
    expect(a[1] - a[0]).toBeGreaterThan(2.5)
    expect(a[1] - a[0]).toBeLessThan(4.5)
    // a statistic that does not depend on the sample has a point interval
    expect(bootstrapInterval(5, () => 3, 100, 1)).toEqual([3, 3])
  })
})
