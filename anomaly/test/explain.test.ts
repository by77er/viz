/** Explanations are true: their numbers are the computed ones, and the sentences read as specified. */
import { describe, expect, it } from 'vitest'
import { ewma, robustZ, seasonal, stl, cusum, peltDetector, threshold, detectGroup, fmt, time } from '../src/index.ts'
import type { DetectResult, Point } from '../src/index.ts'
import { DAY, gauss, HOUR, make, MIN, rng, T0 } from './helpers.ts'

const flagged = (r: DetectResult<unknown>) => r.points.filter((p) => p.anomalous)

/** For deviation-style detectors: explanation value/reference/deviations are the point's value/expected/score, and the text prints them. */
function checkDeviation(p: Point) {
  const e = p.explanation!
  expect(e).toBeDefined()
  expect(e.value).toBe(p.value)
  expect(e.reference).toBe(p.expected)
  expect(e.deviations).toBe(p.score)
  expect(e.spread! * (p.upper! - p.expected!) / (p.upper! - p.expected!)).toBe(e.spread)
  expect(e.direction).toBe(p.value! >= p.expected! ? 'above' : 'below')
  expect(e.text).toContain(fmt(p.value!))
  expect(e.text).toContain(fmt(p.expected!))
  expect(e.text).toContain(`${fmt(p.score)} `)
  expect(e.text).toContain(` ${e.direction} `)
  expect(e.at).toBe(p.ts)
}

describe('deviation explanations carry the computed numbers', () => {
  const r = rng(5)
  const s = make(600, 5 * MIN, () => 100 + gauss(r))
  s.values[400] = 140
  s.values[500] = 60
  it.each([
    ['ewma', () => ewma.detect(s, { stepMs: 5 * MIN })],
    ['robust_z', () => robustZ.detect(s, { stepMs: 5 * MIN })],
    ['stl', () => stl.detect(make(240, HOUR, (i) => 100 + 30 * Math.sin((2 * Math.PI * i) / 24) + (i === 200 ? 25 : 0) + gauss(r)), { periodMs: DAY })],
  ] as const)('%s', (_n, run) => {
    const out = flagged(run())
    expect(out.length).toBeGreaterThan(0)
    out.forEach(checkDeviation)
  })
  it('the band is k spreads wide: upper − expected = k · spread', () => {
    const p = flagged(robustZ.detect(s, { stepMs: 5 * MIN, k: 3.5 }))[0]!
    expect(p.upper! - p.expected!).toBeCloseTo(3.5 * p.explanation!.spread!, 9)
    expect(p.score).toBeCloseTo(Math.abs(p.value! - p.expected!) / p.explanation!.spread!, 9)
  })
})

describe('the sentences in the brief', () => {
  it('"N standard deviations above the median of the same hour over the last 4 weeks"', () => {
    const r = rng(9)
    const s = make(5 * 7 * 24, HOUR, (i) => 200 + 80 * Math.sin((2 * Math.PI * (i % 24)) / 24) + (i % 168 >= 120 ? -60 : 0) + 3 * gauss(r))
    const at = 4 * 7 * 24 + 3 * 24 + 14 // week 5, Thursday 14:00
    s.values[at] = s.values[at]! + 60
    const out = seasonal.detect(s, { periodMs: 7 * DAY, seasons: 4, stepMs: HOUR })
    const p = out.points[at]!
    expect(p.anomalous).toBe(true)
    checkDeviation(p)
    expect(p.explanation!.text).toBe(
      `${fmt(p.value!)} is ${fmt(p.score)} robust standard deviations above the median of the same hour of the week over the last 4 weeks (${fmt(p.expected!)})`,
    )
    expect(p.explanation!.facts.seasonsUsed).toBe(4)
    // the reference really is the median of the four previous weeks at that hour
    const prev = [1, 2, 3, 4].map((j) => s.values[at - j * 168]!).sort((a, b) => a - b)
    expect(p.expected).toBeCloseTo((prev[1]! + prev[2]!) / 2, 12)
  })
  it('"mean shifted from 120 ms to 310 ms at 13:02" (CUSUM and PELT)', () => {
    const r = rng(10)
    const s = make(400, MIN, (i) => (i < 300 ? 120 : 310) + 10 * gauss(r), T0 + 13 * HOUR + 2 * MIN - 300 * MIN)
    for (const out of [cusum.detect(s, { unit: 'ms', stepMs: MIN }), peltDetector.detect(s, { unit: 'ms' })]) {
      const p = flagged(out).find((q) => q.ts >= s.ts[300]!)! // CUSUM may also raise a false alarm earlier (in-control ARL ≈ 195)
      const e = p.explanation!
      expect(e.kind).toBe('level_shift')
      expect(e.text).toMatch(/^mean shifted from 1[12]\d ms to 3[01]\d ms at 2026-01-05 1[23]:\d\d UTC \([\d.]+ standard deviations\)$/)
      expect(e.text).toContain(`from ${fmt(e.reference)} ms to ${fmt(e.value)} ms at ${time(e.at)}`)
    }
    // PELT: the numbers are exactly the segment means and the first point of the new segment
    const pe = flagged(peltDetector.detect(s, { unit: 'ms' }))[0]!.explanation!
    const before = Array.from(s.values.subarray(0, 300))
    const after = Array.from(s.values.subarray(300))
    expect(pe.reference).toBeCloseTo(before.reduce((a, b) => a + b) / 300, 9)
    expect(pe.value).toBeCloseTo(after.reduce((a, b) => a + b) / 100, 9)
    expect(pe.at).toBe(s.ts[300])
  })
  it('threshold explanations quote the threshold and recovery level actually used', () => {
    const s = make(3, MIN, (i) => [100, 612, 470][i]!)
    const out = threshold.detect(s, { above: 500, recoverAbove: 450, unit: 'req/s' })
    expect(out.points[1]!.explanation!.text).toBe('612 req/s is above the threshold 500 req/s by 22.4% (fires above 500 req/s, recovers below 450 req/s)')
    expect(out.points[2]!.explanation!.text).toBe('470 req/s is back below the threshold 500 req/s but not yet below the recovery level 450 req/s, so the alert holds (fires above 500 req/s, recovers below 450 req/s)')
  })
  it('cross-series names the member and its peers', () => {
    const r = rng(11)
    const members = Array.from({ length: 50 }, (_, i) => ({ id: `pod-${i}`, value: i === 17 ? 940 : 210 + 5 * gauss(r) }))
    const out = detectGroup(members, { unit: 'ms' })
    const p = out.members.find((m) => m.anomalous)!
    expect(p.id).toBe('pod-17')
    expect(p.explanation!.text).toMatch(/^pod-17: 940 ms is [\d.]+ robust standard deviations above the median of its 50 peers at the same time \(2\d\d ms\)$/)
    checkDeviation(p)
  })
})
