/**
 * The SRE Workbook's example SLO (99.9% over 30 days, approach 6 rules): detection time and
 * budget consumed when the first alert fires, for a range of constant error ratios starting
 * at t = 0 — from the workbook's formulas and from the detector run on simulated 1-minute
 * buckets (they must agree to within one bucket). Also the workbook's quoted numbers.
 *
 *   node --experimental-strip-types bench/burn-table.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { burnRate, SRE_WORKBOOK_RULES, ruleDetectionTimeMs, budgetConsumed, burnRateFor, timeToExhaustionMs, detectionTimeMs, resetTimeMs, type BurnRule } from '../src/index.ts'

const S = 1000, MIN = 60 * S, H = 60 * MIN, D = 24 * H, P = 30 * D, SLO = 0.999
const fmtT = (ms: number) => (!Number.isFinite(ms) ? 'never' : ms < MIN ? `${(ms / S).toFixed(1)} s` : ms < 2 * H ? `${(ms / MIN).toFixed(1)} min` : ms < 2 * D ? `${(ms / H).toFixed(1)} h` : `${(ms / D).toFixed(2)} d`)
const name = (r: BurnRule) => `${r.severity} ${r.longMs >= D ? r.longMs / D + 'd' : r.longMs / H + 'h'}/${r.shortMs >= H ? r.shortMs / H + 'h' : r.shortMs / MIN + 'm'} ×${r.burnRate}`

function simulate(e: number, bucket: number, horizon: number) {
  const warm = 3 * D
  const n = Math.round((warm + horizon) / bucket)
  const ts = new Float64Array(n), bad = new Float64Array(n), total = new Float64Array(n).fill(1e6)
  for (let i = 0; i < n; i++) {
    const t = i * bucket - warm
    ts[i] = t
    bad[i] = (1e6 * e * Math.max(0, Math.min(t, horizon) - Math.max(t - bucket, 0))) / bucket
  }
  const r = burnRate.detect({ ts, values: bad, total } as never, { objective: SLO, stepMs: bucket })
  const p = r.points.find((q) => q.anomalous)
  return p ? { at: p.ts, rule: `${p.explanation!.facts.severity} ${(p.explanation!.facts.longWindowMs as number) >= D ? (p.explanation!.facts.longWindowMs as number) / D + 'd' : (p.explanation!.facts.longWindowMs as number) / H + 'h'}` } : null
}

const lines: string[] = []
lines.push('| error ratio | burn rate | ' + SRE_WORKBOOK_RULES.map(name).join(' | ') + ' | first alert (formula) | budget spent then | detector, 1-min buckets |')
lines.push('|---' + '|---'.repeat(SRE_WORKBOOK_RULES.length + 4) + '|')
for (const e of [1, 0.5, 0.1, 0.05, 0.02, 0.01, 0.005, 0.003, 0.002, 0.0015, 0.001]) {
  const times = SRE_WORKBOOK_RULES.map((r) => ruleDetectionTimeMs(e, SLO, r))
  const first = Math.min(...times)
  const spent = Number.isFinite(first) ? budgetConsumed(e / (1 - SLO), first, P) : NaN
  const sim = simulate(e, MIN, Number.isFinite(first) ? Math.min(first + H, 4 * D) : 4 * D)
  lines.push(`| ${(100 * e).toFixed(2)}% | ${(e / (1 - SLO)).toFixed(1)} | ${times.map(fmtT).join(' | ')} | ${fmtT(first)} | ${Number.isFinite(spent) ? (100 * spent).toFixed(1) + '%' : '–'} | ${sim ? `${fmtT(sim.at)} (${sim.rule})` : 'never'} |`)
}
lines.push('', '| workbook says | computed here |', '|---|---|')
const q: [string, string][] = [
  ['Table 5-4: burn 1 / 2 / 10 / 1,000 → 30 d / 15 d / 3 d / 43 min to exhaustion', [1, 2, 10, 1000].map((b) => fmtT(timeToExhaustionMs(b, P))).join(' / ')],
  ['Table 5-6: 2% in 1 h → 14.4; 5% in 6 h → 6; 10% in 3 d → 1', [burnRateFor(0.02, H, P), burnRateFor(0.05, 6 * H, P), burnRateFor(0.1, 3 * D, P)].map((x) => x.toFixed(2)).join(' / ')],
  ['Table 5-8: budget consumed 2% / 5% / 10% (and 10% for 24h/2h ×3)', SRE_WORKBOOK_RULES.map((r) => (100 * budgetConsumed(r.burnRate, r.longMs, P)).toFixed(1) + '%').join(' / ')],
  ['Approach 1: 0.6 s detection for a total outage over 10 min; 0.02% of budget', `${fmtT(detectionTimeMs(1, SLO, 10 * MIN, 1 - 1e-12))}; ${(100 * budgetConsumed(1, 10 * MIN, P)).toFixed(3)}%`],
  ['Approach 2: 36 h window = 5%; "2 minutes and 10 seconds" for a complete outage', `${(100 * budgetConsumed(1, 36 * H, P)).toFixed(1)}%; ${fmtT(detectionTimeMs(1, SLO, 36 * H, 1 - 1e-12))}`],
  ['Approach 3: 1 h total outage = "140%" of budget; 5-min spike "almost 12%"', `${(100 * budgetConsumed(1000, H, P)).toFixed(1)}%; ${(100 * budgetConsumed(1000, 5 * MIN, P)).toFixed(1)}%`],
  ['Approach 4: 5% in 1 h → burn 36; reset "58 minutes"; 35× empties the budget in "20.5 hours"', `${burnRateFor(0.05, H, P).toFixed(1)}; ${fmtT(resetTimeMs(H, 36, SLO))}; ${fmtT(timeToExhaustionMs(35, P))}`],
  ['Low traffic: 1 failure in 10 req/h is "1,000x" and "13.9%" of the budget', `${(0.1 / 0.001).toFixed(0)}× (the text's 1,000× is a slip); ${(100 * budgetConsumed(100, H, P)).toFixed(1)}%`],
  ['90% SLO: a total outage spends "1.4%" per hour, so 14.4× never fires', `${(100 * budgetConsumed(10, H, P)).toFixed(2)}%; max burn 10 < 14.4`],
  ['99.999%: "26 seconds" to exhaustion; 1% canary at 1% budget: "43 minutes"', `${fmtT(timeToExhaustionMs(1e5, P))}; ${fmtT(timeToExhaustionMs(1000, P))}`],
]
for (const [a, b] of q) lines.push(`| ${a} | ${b} |`)
console.log(lines.join('\n'))
mkdirSync(new URL('./out/', import.meta.url).pathname, { recursive: true })
writeFileSync(new URL('./out/burn-table.md', import.meta.url).pathname, lines.join('\n') + '\n')
