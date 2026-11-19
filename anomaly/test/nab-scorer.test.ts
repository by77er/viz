/**
 * The NAB scorer port (bench/nab.ts) against NAB's own nab/sweeper.py on toy cases
 * (scripts/nab-sweeper-fixture.py), and — when the corpus has been fetched — against NAB's
 * published final_results.json for three of its detectors.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import {
  sweepRows, weighted, scoreAt, optimizeThreshold, normalize, nullScore, probationaryLength, scaledSigmoid, windowMetrics,
  loadCorpus, loadProfiles, loadPublishedScores, publishedFinalResults, NAB_DIR, PROFILE_NAMES, type NabFile, type CostMatrix,
} from '../bench/nab.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/nab-sweeper.json', import.meta.url), 'utf8'))
const CM: Record<string, CostMatrix> = {
  standard: { tpWeight: 1, fnWeight: 1, fpWeight: 0.11 },
  reward_low_FP_rate: { tpWeight: 1, fnWeight: 1, fpWeight: 0.22 },
  reward_low_FN_rate: { tpWeight: 1, fnWeight: 2, fpWeight: 0.11 },
}
const toy = (n: number, windows: [number, number][]): NabFile => ({
  path: 'toy/x.csv', category: 'toy', stamps: Array.from({ length: n }, (_, i) => String(i)),
  ts: Float64Array.from({ length: n }, (_, i) => i), values: new Float64Array(n), windows, labels: windows.map(([a, b]) => Math.floor((a + b) / 2)),
})

describe('NAB scoring equals NAB sweeper.py', () => {
  type Case = { name: string; n: number; windows: [number, number][]; scores: number[]; threshold: number; results: Record<string, { score: number; tp: number; fp: number; fn: number; tn: number; rowScores: number[]; bestThreshold: number; bestScore: number }> }
  for (const c of fixture.cases as Case[]) {
    it(c.name, () => {
      const f = toy(c.n, c.windows)
      const rows = sweepRows(f)
      for (const p of Object.keys(CM)) {
        const want = c.results[p]!
        const w = weighted(rows, CM[p]!)
        for (let i = 0; i < c.n; i++) expect(w[i]).toBeCloseTo(want.rowScores[i]!, 12)
        const got = scoreAt([{ rows, scores: c.scores }], CM[p]!, c.threshold)
        expect(got.score).toBeCloseTo(want.score, 12)
        expect([got.tp, got.fp, got.fn, got.tn]).toEqual([want.tp, want.fp, want.fn, want.tn])
        const best = optimizeThreshold([{ rows, scores: c.scores }], CM[p]!)
        expect(best.score).toBeCloseTo(want.bestScore, 12)
        expect(best.threshold).toBe(want.bestThreshold)
      }
    })
  }
  it('hand-checked values: earliest detection earns tpWeight; probation is min(floor(0.15 n), 750)', () => {
    expect(probationaryLength(100)).toBe(15)
    expect(probationaryLength(10_000)).toBe(750)
    expect(scaledSigmoid(-1)).toBeCloseTo(0.98661, 5)
    expect(scaledSigmoid(0)).toBe(0)
    expect(scaledSigmoid(3.5)).toBe(-1)
    const f = toy(100, [[60, 69]])
    const rows = sweepRows(f)
    const s = new Float64Array(100)
    s[60] = 1
    expect(scoreAt([{ rows, scores: s }], CM.standard!, 0.5).score).toBeCloseTo(1, 12)
    expect(normalize(1, nullScore([{ rows }], CM.standard!), 1, CM.standard!)).toBe(100)
  })
  it('no caller passes sweepRows to map(): its optional second argument (probation) would receive the index', () => {
    // a bare `.map(sweepRows)` once silently gave each file a probation equal to its position
    const dirs = ['../bench/', './'].map((d) => new URL(d, import.meta.url).pathname)
    const offenders = dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.ts')).map((f) => d + f))
      .filter((p) => /\.map\(\s*sweepRows\s*\)/.test(readFileSync(p, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')))
    expect(offenders).toEqual([])
    const f = toy(100, [[60, 69]])
    expect(Array.from(sweepRows(f).window.slice(0, 16))).toEqual([...Array(15).fill(-2), -1])
  })
  it('window metrics: recall, event precision, delay from the label', () => {
    const f = toy(100, [[60, 69]])
    const det = new Uint8Array(100)
    det[66] = det[67] = 1 // one event inside the window
    det[30] = 1 // one false event
    const m = windowMetrics([{ file: f, rows: sweepRows(f), detections: det }])
    expect([m.windows, m.detectedWindows, m.events, m.eventsInWindows]).toEqual([1, 1, 2, 1])
    expect(m.delaysFromLabel).toEqual([66 - 64])
  })
})

describe.skipIf(!existsSync(`${NAB_DIR}results/windowedGaussian`))('reproduces NAB published scores (needs bash bench/fetch-nab.sh --results)', () => {
  it.each(['windowedGaussian', 'relativeEntropy', 'numenta'])('%s at NAB\'s stored thresholds', (det) => {
    const files = loadCorpus()
    const profiles = loadProfiles()
    const rows = files.map((f) => sweepRows(f))
    const stored = JSON.parse(readFileSync(`${NAB_DIR}config/thresholds.json`, 'utf8'))
    const entries = files.map((f, i) => ({ rows: rows[i]!, scores: loadPublishedScores(det, f) }))
    const nWindows = files.reduce((a, f) => a + f.windows.length, 0)
    for (const p of PROFILE_NAMES) {
      const raw = scoreAt(entries, profiles[p], stored[det][p].threshold).score
      const ours = normalize(raw, nullScore(rows.map((r) => ({ rows: r })), profiles[p]), nWindows, profiles[p])
      expect(ours).toBeCloseTo(publishedFinalResults()[det]![p], 8)
    }
  })
})
