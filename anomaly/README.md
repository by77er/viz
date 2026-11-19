# Anomaly detection

Pure TypeScript detectors for the viz ruler (design §7, research 08 §4). No I/O, no clock, no
randomness: callers pass time, history and state. Runs in Workers, Durable Objects and Node;
ESM; no runtime dependencies. The ruler runs the single-series detectors as **anomaly rules**
(`contracts/rules.ts`, contract version 2; `ruler/src/anomaly.ts`); "Integration" says how, and
what of the plan below was built differently.

Every number below was **measured on this machine** (Node 22.23, Linux, shared with other
sessions' processes) unless it says otherwise. Nothing was deployed or run on Cloudflare.

**In one paragraph.** All the requested detectors are built and verified against independent
implementations and the SRE Workbook. On the NAB benchmark, scored honestly (parameters
chosen on the other half of the files), the methods as specified mostly do **not** earn their
place: EWMA beats the static threshold (30.1 vs 21.8, standard profile), but the median/MAD
robust z-score (−105.9), the MAD seasonal baseline (−76.4), STL residuals (−352.2), CUSUM
(15.1) and rolling PELT (−123.5) do worse than a static threshold, because on NAB's
heavy-tailed series the MAD describes only the bulk and routine spikes score 20+ "robust σ".
Replacing the MAD with a tail-aware spread (the 99th percentile of |x − median|, Datadog's
"basic" idea) — a change made **after** seeing these results — gives 44.8 (robust z) and 41.4
(seasonal), above NAB's windowedGaussian (39.6) but well below relativeEntropy (54.6), HTM
(68.7) and ARTime (73.3). The seasonal baseline earns its place on the anomalies it is built
for (phase-wrong values: 4 of 4 artificial daily anomalies caught versus 1 of 4 without, and
nyc_taxi), not on NAB in aggregate. **On a second benchmark the choice had never seen** (SMD,
28 servers' metrics, every parameter frozen on NAB before the data were fetched) the quantile
spread **generalised** by a rule fixed in advance: robust z 42.8 and seasonal 35.5, first and
second as on NAB, above the static threshold (16.4) and EWMA (10.4), event F1 0.441 against
0.328 and 0.206. EWMA did not: it fell below the static threshold. A proposed amendment to D33
follows the SMD results; the validated window is over the ruler's state limit today.

## Files

| Path | Contents |
|---|---|
| `src/types.ts` | `Series`, `Point`, `Explanation`, `Summary`, `HistoryNeed`, the `Detector` interface |
| `src/detectors/threshold.ts` | static threshold with hysteresis (tier 0) |
| `src/detectors/ewma.ts` | EWMA mean/variance with bands (tier 0) |
| `src/detectors/robustz.ts` | robust z-score, median/MAD (or quantile spread) over a trailing window (tier 0) |
| `src/detectors/seasonal.ts` | seasonal baseline: blend of the k most recent seasons, robust bands, robust/agile (tier 0) |
| `src/detectors/burnrate.ts` | multi-window multi-burn-rate SLO alerts and the error-budget arithmetic (tier 0) |
| `src/detectors/seasonality.ts` | automatic seasonality detection: hourly / daily / weekly with a confidence (tier 1) |
| `src/detectors/stl.ts` | STL (LOESS, port of Cleveland's `stl.f`), fitted models, residual anomalies (tier 1) |
| `src/detectors/cusum.ts` | two-sided tabular CUSUM for mean shifts (tier 1, cheap enough for tier 0) |
| `src/detectors/pelt.ts` | PELT changepoints, Gaussian mean cost, stated penalty (tier 1) |
| `src/detectors/crossseries.ts` | one member of a group unlike its peers: median/MAD across the group (tier 1, stateless) |
| `src/explain.ts` | sentence builders; deterministic number, duration and UTC time formatting |
| `src/cost.ts` | history → `tail` / `recent` / `rollup`, same thresholds as `ruler/src/classify.ts` |
| `src/prom.ts` | engine results (`PromMatrix`, `PromVector` from `contracts/engine.ts`) → detector input |
| `src/stats.ts`, `src/base.ts` | median, MAD, quantiles, weighted median, step inference; shared helpers |
| `test/` | 275 tests (vitest, fast-check); `test/fixtures/` from statsmodels, ruptures and NAB's `sweeper.py`; `test/regressions.test.ts` keeps every counterexample the property tests found |
| `bench/nab.ts` | NAB corpus loader and a line-by-line port of NAB's scorer |
| `bench/fetch-nab.sh`, `bench/nab-manifest.json` | fetch NAB into `bench/data/` (git-ignored); SHA-256 of every data and label file used |
| `bench/verify-scorer.ts`, `bench/nab-run.ts`, `bench/adapters.ts` | scorer check; the benchmark; how each detector runs on NAB and the tuning grids |
| `bench/burn-table.ts`, `bench/cpu.ts` | SRE Workbook table; CPU, state size, history per detector |
| `bench/freeze.ts`, `bench/smd-frozen.json` | second benchmark, step 1: every parameter chosen on NAB alone and the SMD protocol, written with a timestamp before SMD was fetched (refuses to overwrite) |
| `bench/fetch-smd.sh`, `bench/smd-manifest.json` | fetch SMD into `bench/data/smd/` (git-ignored; refuses to run before the freeze); SHA-256 of every SMD file used |
| `bench/smd.ts`, `bench/smd-run.ts` | SMD loader and scorer (NAB-rule windows, don't-care spans, event metric, machine bootstrap); the run, resumable per machine |
| `scripts/mutants.mjs` | 38 mutation checks, applied to a throw-away copy in a scratch directory; `--verify-clean` checks the tree read-only |
| `scripts/make-fixtures.py`, `scripts/nab-sweeper-fixture.py` | fixture generators (independent implementations) |

Dependencies (dev only): `vitest` (tests), `fast-check` (property tests), `typescript`
(`tsc --noEmit`), `@types/node` (tests and bench read files; `src/` is checked by a test to use
no Node API), `rolldown` (pinned to the version vitest already installs; bundles `src/` for the
no-Node test). Runtime: none.

## What is implemented

### The interface

```ts
detector.detect(series: { ts: Float64Array /* ms */, values: Float64Array }, params?, state?)
  → { points: Point[], state, summary }
detector.history(params, stepMs) → { lookbackMs, resolutionMs, minPoints, incremental, tickLookbackMs, reason }
```

- One `Point` per input point: `{ ts, value, expected, lower, upper, score, anomalous, status, explanation? }`.
  `status` is `ok`, `missing` (NaN, ±Inf, |x| > 1e150; a timestamp that is out of order,
  non-finite or outside ±8.64e15 ms, the Date range: not scored, state untouched) or `warming` (valid, but not enough history to score).
  `score` is always finite and ≥ 0, in the detector's own unit.
- `state` is a plain JSON object with a version field, no NaN, Infinity or −0, so it survives a
  JSON round trip unchanged (property-tested). `summary.stateBytes` is its UTF-8 JSON size.
  A state whose shape or parameters do not match is ignored, never trusted.
- **Incremental detectors** (threshold, EWMA, robust z, seasonal, burn rate, CUSUM, STL
  scoring against a stored model): feeding a series in chunks, with the state through JSON
  between chunks, gives exactly the points of one batch call (property-tested; pass `stepMs`
  explicitly — an inferred step depends on which points the first call saw).
- **Batch detectors** (STL fit, PELT, seasonality detection, cross-series) take the history
  each run. STL returns its fitted model as state, so the design's "refit on a schedule, score
  online" is `detect(history)` then `detect(newPoints, params, model)`.
- **Not enough history**: `summary.status = 'not_enough_history'` and a message saying what is
  needed ("needs 2 previous days (2 days) at this phase and 12 residuals before scoring");
  nothing is guessed.
- **Gaps and NaN**: missing points are never zeros. Time windows shrink, ring buffers mark the
  slot missing, blends leave the season out. A NaN point gives the same results for every
  other point as no point at all (property-tested for every detector).
- **Staleness**: `staleAfterMs` resets the hysteresis state (threshold) or restarts the warm-up
  (EWMA, CUSUM) after a gap; time-indexed detectors (robust z window, seasonal, burn rate)
  age data out by time. Default: never (the ruler's no-data policy decides what a gap means).
- **Counter resets are the caller's concern**: detectors see gauges. Pass `rate()`/`increase()`
  results (the engine handles resets), and per-bucket increments for burn rate.
- Common parameters: `stepMs`, `minDeviation` (absolute floor on |x − expected|, research 08
  §4.7), `direction` (`above` / `below` / `both`), `minSpread`, `unit` (for explanations).

### Detectors

| Detector | Method | Score unit | State | History (cold start) |
|---|---|---|---|---|
| `threshold` | fires above `above` / below `below`; holds until back past `recoverAbove` / `recoverBelow` | relative exceedance | 4 numbers | none |
| `ewma` | EW mean and variance (West's update), one-step-ahead, α from a half-life in steps (gaps decay by time); anomalous values folded in clipped to the band, unclipped after `acceptAfter` (5) in a row | σ | 7 numbers | ~2 half-lives |
| `robustZ` | median and 1.4826·MAD of the trailing time window (MeanAD × 1.2533 if MAD = 0); or `spread: 'quantile'`: the q-quantile of |x − median| | robust σ (or multiples of the q-deviation) | the window's points | the window |
| `seasonal` | expected = median (or weighted median / weighted mean, decay^(j−1)) of x(t − jP), j = 1..k; spread = 1.4826·MAD (or quantile) of recent residuals; `agile` adds a level correction (median residual over `agileWindowMs`); anomalous values stored clipped until `acceptAfter` in a row | robust σ | (k·P + 1) values + residual ring | k periods + residual window |
| `burnRate` | Google SRE Workbook ch. 5, approach 6: both windows strictly above the rule's burn rate; defaults are the workbook's four rules (1h/5m ×14.4, 6h/30m ×6, 24h/2h ×3, 3d/6h ×1) for 99.9 % over 30 days; `minEvents` low-traffic guard; `minCoverage` for missing buckets. Also `evaluateWindows` (stateless, from recording-rule aggregates) and the arithmetic (`budgetConsumed`, `burnRateFor`, `detectionTimeMs`, `resetTimeMs`, `timeToExhaustionMs`) | min(long, short burn) / threshold | ring of the longest window's buckets | longest window |
| `detectSeasonality` | for each of 1 h, 1 d, 1 w: detrend with a centred moving average of the period, autocorrelation at the period and at half of it over present pairs; seasonal if acf ≥ 0.3, a peak (acf(P) − acf(P/2) ≥ 0.1) and beyond 3/√pairs; shortest seasonal candidate unless a longer one is 0.1 better; confidence = acf | — | — | 2 cycles |
| `stl` | real STL (LOESS inner/outer loops, robustness weights), ported from `stl.f` with its jump parameters; detector defaults: periodic seasonal (R's `s.window = "periodic"`), R's jumps (window/10), last ≤ 8 periods; residual score | robust σ of residuals | the model: P seasonal values + level, slope, σ | 2 periods |
| `cusum` | tabular CUSUM, k = 0.5, h = 5 (σ units), μ₀ = median, σ₀ = 1.4826·MAD(Δx)/√2 of 60 warm-up points; at an alarm the change is located in the excursion by the likelihood-ratio split; reference re-learned from the next 30 points | statistic / h | ~15 numbers + the excursion | warm-up |
| `pelt` | exact PELT, Gaussian mean cost Σ(x − x̄)²/σ², **penalty β = 2·ln n** (σ² units; BIC-style: location and new mean per change), minimum segment 5, σ from first differences | |Δmean| / σ at the change | none | caller's window |
| `detectGroup` / `detectGroupWindow` | median and 1.4826·MAD across the members at one timestamp; window version flags members outlying at ≥ `minFraction` of timestamps | robust σ | none | none |

Why real STL rather than a simpler decomposition: the design names it, its robustness
weights stop the anomaly itself from bending the fit, and it can be checked number for number
against an independent implementation (statsmodels), which it matches to 1e-9.

### Explanations

Every anomalous point carries `explanation`: one sentence built only from its own fields, and
the fields themselves (`value`, `reference`, `referenceLabel`, `deviations`, `spread`, `at`,
`direction`, `facts`). Actual output on the test scenarios (`test/explain.test.ts`,
`test/synthetic.test.ts`):

- `"222 is 17.1 robust standard deviations above the median of the same hour of the week over the last 4 weeks (159)"` (seasonal)
- `"mean shifted from 120 ms to 310 ms at 2026-01-05 13:02 UTC (20 standard deviations)"` (PELT)
- `"mean shifted from 122 ms to 323 ms at 2026-01-05 13:02 UTC (20.4 standard deviations)"` (CUSUM, one point after the change)
- `"pod-17: 940 ms is 113 robust standard deviations above the median of its 50 peers at the same time (209 ms)"`
- `"612 req/s is above the threshold 500 req/s by 22.4% (fires above 500 req/s, recovers below 450 req/s)"`
- `"error budget burning at 16.7× over 1 hour and 200× over 5 minutes (page threshold 14.4×); 2.31% of the 30 days budget for a 99.9% objective was spent in the last 1 hour"`
- `"90 is 4 times the 99th-percentile deviation, above the median of the last 1 day (32.1)"` (robust z, quantile spread)

Tests check that the numbers in the text are the computed ones (value = point.value,
reference = point.expected, deviations = point.score; PELT's means are the segment means).

## Integration (built in the ruler)

The ruler imports this library (`ruler/src/anomaly.ts`, no copy) and evaluates **anomaly rules**:
an alerting rule-file entry with an `anomaly` block, or a monitor with `query` and `anomaly`
(`ruler/README.md`, part 8, has the whole of it, the tests and the mutants). It also evaluates
**SLO burn-rate rules** with this library's Workbook alerts (part 10, D42) and **warms new rules
of both kinds from history** (part 11, D43). In short:

- **Rule shape** (`contracts/rules.ts`, contract version 2, additive): `anomaly: { detector,
  params, unit, severity, max_series }` next to `expr`, which is the series to watch. Detectors
  in rules: `ewma`, `threshold`, `robust_z`, `seasonal`, `cusum` (`ANOMALY_DETECTORS`); `stl`,
  `pelt` and `burn_rate` are refused, with the reason (burn rate is its own rule kind, below). Every parameter is resolved and written
  out at save, so a later change of a default here never changes a stored rule.
- **Defaults follow the held-out results below** (design D33): `ewma` with half-life 100 and
  k 8 (chosen on both folds), not this library's 30 / 4 (0.0 under NAB's protocol);
  `severity: page` with no detector is a static `threshold` (it beat EWMA in the low-FP profile,
  5.5 against 3.9); `cusum` defaults to `info` and may not page. A rule naming robust z or
  seasonal with the MAD spread is saved with a warning that quotes its held-out score; the
  quantile spread is accepted with a warning that it is post hoc and unconfirmed. The guide
  is served at `GET /api/v1/monitors/detectors`.
- **At save**: `history(params, intervalMs)` and `classify` give the tick and cold-start classes
  (`AnomalyHistory`, shown to the author with the rule's cost); the rule's cost class is the
  larger of the expression's and the detector's tick class.
- **Each tick**: one point per series, `detect([point], params, state)` from in-memory state, as
  planned. `ok && anomalous` → the series is the rule's result, with the sentence in the
  `anomaly` annotation (and `description` when the author wrote none) and the numbers as
  `AnomalyDetail` JSON in `anomaly_detail`; `warming` → not returned, the rule's status says
  "warming" with `summary.message`; `missing` → not scored and the previous flag kept (a gap is
  not a recovery). `for`, `keep_firing_for`, no-data policies, the hand-off and the notifier are
  the alerting rule's, unchanged.
- **State, built differently from this README's earlier plan**, which was to keep state in
  memory and write it at the heartbeat (5 minutes). The ruler writes it **every tick, in the transaction that commits the tick's alerts**, as whole
  batches per row (all of a rule's series in rows of at most 512 KiB; never a row per series or
  per sample), because state must be rebuilt from SQLite alone and a replayed tick must
  reproduce its outcome: a heartbeat write would lose up to five minutes of points at an
  eviction. Measured in workerd: one row per rule per tick for EWMA, threshold and CUSUM at 100
  series, 2 for robust z, 4 to 6 for seasonal (`ruler/README.md`, measurements).
- **Warming from history** (`ruler/README.md` part 11, design D43; contract version 4): a new
  anomaly rule (a new rule key) gets a warm-up job. At its first tick the ruler reads the
  detector's look-back at the rule's interval (`max(minPoints, lookbackMs / interval)` points,
  from this library's `history()`), first asking viz-query's `/api/v1/plan` for the cost of every
  piece; over the budget (`RulerLimits.maxWarmup*`: 3,000,000 samples, 16 MiB) or on the engine's
  own refusal the warm-up is refused whole and the rule warms live, saying why. Otherwise the
  points are fed in time order through the same `detect` a tick calls, and the state and status
  are committed in one transaction. The threshold needs none (`not_needed`). Rules saved before
  that release are not warmed. Backtests of anomaly rules start from the state such a warm-up
  would leave (part 12).
- **Bounds.** A per-rule series cap (`max_series`, default 100 or what fits the per-rule state
  limit): above it the evaluation is refused (`series_cap_exceeded`), nothing is scored and no
  alert changes. State limits per series, per rule and per object (the object's is checked at
  save from `stateBytesPerSeries × max_series`, because state lives in memory between ticks).
- **Measured here (workerd, local)**, in the ruler's Durable Object under the vitest pool
  (`npm run bench:anomaly` in `ruler/`; load average 17–21 on 4 shared cores): one batch call of
  this library costs in workerd what it costs in Node (ms CPU per 1,000 points: EWMA 0.26 against
  0.14 here, robust z 3.2 against 3.6, seasonal daily 10.3 against 9.8, the rest within 10%). In
  the ruler's per-tick path the cost is serialising each series' state, as "one tick through JSON
  state" below predicted, without the parse: EWMA 10–17 ms per 1,000 points, robust z 100–111,
  seasonal daily 197–209; a whole tick of a 100-series EWMA rule costs about 1–1.5 ms CPU more
  than an empty one (`ruler/README.md`, "Anomaly rules" under Measurements).
- **SLO burn-rate rules** (`ruler/README.md` part 10, design D42; contract version 4): an
  objective, a compliance window and an SLI written with `$window`. The ruler sends one
  expression per rule per tick (the SLI's two parts over the last interval), keeps per-series
  bucket rings in its own storage, and judges the windows with this library's
  `SRE_WORKBOOK_RULES` and `evaluateWindows` (one alert per series and severity, `page` and
  `ticket`). Not compiled to recording rules, and not the incremental `burnRate.detect` (its JSON
  state would be rewritten every tick); D42 replaces D33's "burn rate is to compile to
  recording rules". The window sums are the ruler's own (a second implementation of the
  summing), tested to agree with `burnRate.detect` at every point of 7,320 buckets when the
  counts are whole numbers (`ruler/README.md`, `slo.test.ts`). SLO rules are warmed from
  history the same way (their longest alert window and the compliance window).
- **Not wired**: cross-series, STL refits and PELT as scheduled jobs.

### Contract issues

Resolved by contract version 2 (`contracts/rules.ts`, "anomaly rules"): the rule field (3), the
per-(rule, series) state (3, ruler storage), the two classes (2: `AnomalyHistory.tick` and
`coldStart`, with `RuleCost` the larger of the expression's and the tick class) and "warming"
(4: `AnomalyRuleStatus`). `DESIGN.md` §7 and `DECISIONS.md` (D33) now say what the evidence
below supports (5). Resolved by contract version 4: warming from history (formerly open issue 1;
the ruler reads the look-back through a plan-checked range read at a rule's first tick, D43).
Still open:

1. The guide's numbers in `ruler/src/anomaly.ts` are copied from this README; a change here must
   be made there too (no test ties them). The SMD results below and the proposed amendment to
   D33 change some of them.

## How it was verified

`npm test` (275 tests, 8 files, about 8 s) and `npx tsc --noEmit` pass. Property tests draw
fresh seeds each run; `FC_SEED=<n> npx vitest run test/properties.test.ts` replays one. The
final code passed with seeds −1295174040 (the one CI printed), −568671396, 1, 42, 20261119, −7
and 123456789, and in 12 further random-seed runs.

| What | How | Result |
|---|---|---|
| Known answers | spike, step, seasonal sine with a phase-wrong value, drift, gaps, NaN, constant, too short; for every detector (`test/synthetic.test.ts`) | pass |
| Incremental ≡ batch | 9 detector configurations, random series with gaps, NaN and timestamp jitter, random cut points, state through JSON (fast-check, 150 runs each) | pass |
| Time-shift invariance | every detector, ±10¹² ms shifts on jittered timestamps | pass |
| Scale invariance | values × 2⁻¹⁰, 2, 2¹⁰ (exact in floating point): scores and flags identical, expected scaled (EWMA, robust z, seasonal, STL, CUSUM, PELT, cross-series, burn rate with both counts scaled, threshold with thresholds scaled) | pass |
| NaN ≡ absent | every detector | pass |
| Never throws | any doubles, ±Inf, NaN, −0, MAX_VALUE, unordered timestamps, garbage state; scores finite, state survives JSON | pass; found −0 in state, variance overflow, an infinite slot and an infinite inferred step (twice: locally, and in CI with seed −1295174040), all fixed at the root: values beyond ±1e150 and timestamps beyond the Date range are missing points, so no difference can overflow |
| Regressions | the 7 counterexamples × 11 detector configurations: every number in state finite and not −0, exact JSON round trip, and the restored state gives the same next results as the original | pass (80 tests) |
| STL vs statsmodels 0.15.0 | 6 fixtures (robust and not, ns 7/11/13, degree 0 and 1, with and without jumps) | every component within the test's 1e-9 bound (2.2e-13 measured on the first four) |
| PELT vs ruptures 1.1.10 `Pelt(l2)` | 4 fixtures | identical changepoints |
| PELT vs brute-force optimal partitioning | 1,000 random series, penalties, minimum segments | same optimum; **found a bug**: classic PELT pruning loses the optimum with a minimum segment length (a pruned candidate must stay usable for `minSegment − 1` more steps); fixed |
| Seasonality detection | daily, weekly, hourly, white noise, AR(1) φ = 0.95, random walk, 30 % missing, too short | pass |
| CUSUM in-control run length | iid N(0,1), 40 × 5,000 points | 195 points between false alarms (vs about 465 with known μ, σ); test requires > 150 |
| NAB scorer vs NAB's `sweeper.py` | 5 toy files × 3 profiles, run through NAB's own Python | per-row scores, totals, counts and best thresholds equal |
| NAB scorer vs NAB's published scores | all 15 detectors × 3 profiles from their published per-row outputs, at NAB's stored thresholds | 45 / 45 equal, largest difference 4.5e-11 |
| No Node needed | `src/` scanned for clock, randomness, eval, Node imports; bundled and run in a `node:vm` context with only ECMAScript globals and `TextEncoder`, `Date.now` and `Math.random` poisoned | pass (not a workerd run; see "Not implemented") |
| Mutation checks | 25 mutants, below | 25 killed |

### Burn rate against the SRE Workbook

All expected numbers are quoted from the chapter (`test/burnrate.test.ts`, `bench/burn-table.ts`).

| Workbook says | Computed |
|---|---|
| Table 5-4: burn 1 / 2 / 10 / 1,000 → 30 d / 15 d / 3 d / 43 min to exhaustion | 30 d / 15 d / 3 d / 43.2 min |
| Table 5-6: 2 % in 1 h → 14.4; 5 % in 6 h → 6; 10 % in 3 d → 1 | 14.40 / 6.00 / 1.00 |
| Table 5-8 budget consumed: 2 % / 5 % / 10 % (and 10 % for the 24h/2h ×3 row of its expressions) | 2.0 % / 5.0 % / 10.0 % / 10.0 % |
| Approach 1: 0.6 s for a total outage; a 0.1 % rate for 10 min spends "0.02 %"; 144 alerts a day | 0.6 s; 0.023 %; 144 |
| Approach 2: 36 h = 5 %; "2 minutes and 10 seconds" | 5.0 %; 129.6 s |
| Approach 3: 1 h total outage "140 %"; a 5-min spike "almost 12 %"; three "35 %" | 138.9 %; 11.6 %; 34.7 % |
| Approach 4: 5 % in 1 h → 36×; reset "58 minutes"; 35× never alerts, empties the budget in "20.5 hours" | 36; 57.8 min; never; 20.6 h |
| Figure 5-6: 15 % errors for 10 min: fires "after 5 minutes", stops "5 minutes after" | simulated: fires at 5.76 min, stops 4.52 min after (the long window alone would hold until 54.2 min after; the text says 60, the window length) |
| Low traffic: one failure in 10 req/h is a "1,000x burn rate" and "13.9 %" | 13.9 %, but the burn rate is **100×** (10 % / 0.1 %); 100× for one hour is exactly 13.9 %: the "1,000x" is a slip in the text |
| 90 % SLO: a total outage spends "1.4 %" per hour, 14.4× never fires; 99.999 %: "26 seconds"; 1 % canary: "43 minutes" | 1.39 %; never; 25.9 s; 43.2 min |

Detection time and budget spent at the first alert, 99.9 % over 30 days, workbook formula
`(1 − SLO) / error ratio × window × burn rate` versus the detector on simulated 1-minute buckets:

| error ratio | 1h/5m ×14.4 | 6h/30m ×6 | 1d/2h ×3 | 3d/6h ×1 | first alert | budget spent | detector |
|---|---|---|---|---|---|---|---|
| 100 % | 51.8 s | 2.2 min | 4.3 min | 4.3 min | 51.8 s | 2.0 % | 1.0 min (page 1h) |
| 10 % | 8.6 min | 21.6 min | 43.2 min | 43.2 min | 8.6 min | 2.0 % | 9.0 min (page 1h) |
| 2 % | 43.2 min | 108 min | 3.6 h | 3.6 h | 43.2 min | 2.0 % | 44.0 min (page 1h) |
| 1 % | never | 3.6 h | 7.2 h | 7.2 h | 3.6 h | 5.0 % | 3.6 h (page 6h) |
| 0.5 % | never | never | 14.4 h | 14.4 h | 14.4 h | 10.0 % | 14.4 h (ticket; the two ticket rules tie) |
| 0.2 % | never | never | never | 36 h | 36 h | 10.0 % | 36.0 h (ticket 3d) |
| 0.1 % | never | never | never | never | never | – | never |

A test with 1-second buckets puts the 100 % page at 51.84–52.84 s. The budget spent when a
rule fires equals the table's 2 % / 5 % / 10 % whatever the error ratio (window × burn / period).

### Mutation checks (`node scripts/mutants.mjs`)

| # | Mutant | Caught by |
|---|---|---|
| 1 | robust z: MAD without the 1.4826 constant | exact-score test; σ-estimate test |
| 2 | shared `robust()` without 1.4826 (seasonal, STL, cross-series) | cross-series and explanation tests |
| 3 | seasonal baseline skips the most recent season | "same hour over the last 4 weeks" test; blend test |
| 4 | seasonal baseline one slot off phase | same |
| 5 | gaps treated as zeros (missing value reads as 0, every detector) | NaN ≡ absent (20 tests) |
| 6 | seasonal: skipped slots stored as 0 | "a missing slot is left out" |
| 7 | incremental state not updated (robust z) | incremental ≡ batch |
| 8 | incremental state not updated (EWMA mean) | incremental ≡ batch |
| 9 | hysteresis removed | threshold tests; threshold explanation |
| 10 | changepoint penalty ignored | ruptures fixtures; brute force; penalty test |
| 11 | PELT prunes at once despite the minimum segment (the bug found) | brute-force property |
| 12 | burn-rate windows swapped between rules (14.4× on 6h/30m) | Table 5-8; Figure 5-6; 51.8 s detection |
| 13 | burn-rate long window read from the short window | Figure 5-6; detection-time table |
| 14 | burn-rate threshold `≥` instead of `>` | exact-threshold test (survived the first run: 14.4 × 0.001 is not exact in binary; the test now uses exactly representable numbers) |
| 15 | cross-series with mean and standard deviation instead of median and MAD | six-bad-pods masking test |
| 16 | explanation prints a number not from the computation | explanation tests |
| 17 | explanation reference is the value itself | explanation tests |
| 18 | NaN/Infinity passed into the score | never-throws properties |
| 19 | EWMA folds in a missing value | NaN ≡ absent; never throws |
| 20 | CUSUM allowance k ignored | in-control run-length test |
| 21 | STL robustness weights unused | statsmodels robust fixtures |
| 22 | seasonal slots anchored to the epoch (breaks time-shift invariance) | time-shift property (survived the first run: invisible on exactly regular timestamps; the generator now jitters them) |
| 23 | quantile spread uses the median deviation | heavy-tail test |
| 24 | NAB scorer: 10 % probation instead of 15 % | `sweeper.py` fixtures |
| 25 | NAB scorer: every detection in a window counts | `sweeper.py` fixtures |
| 26 | SMD windows: half-width w instead of ⌊w/2⌋ | NAB-rule window test |
| 27 | SMD windows: width not divided among the segments | NAB-rule window test |
| 28 | SMD segments: dimensions read as 0-based | series-segments test |
| 29 | SMD don't care: machine segments that list the dimension excluded too | don't-care test (would have survived the first version of the tests, seen on reading them before the run: in their only case the listing segment lay inside its window; a case where it outruns the window was added) |
| 30 | SMD rows: don't-care spans not applied | rows test |
| 31 | SMD rows: NAB probation applied inside the test half | rows test |
| 32 | SMD runs: a run begun in the history counted as an onset | runs test |
| 33 | SMD machine view: touching runs not merged into one alarm | union test |
| 34 | SMD event metric: tolerance not applied after the segment end | tolerance tests |
| 35 | SMD event metric: don't-care onsets counted as false | event-count test |
| 36 | SMD bootstrap: machines resampled without replacement | bootstrap test |
| 37 | NAB run: `files.map(sweepRows)` (the index becomes the probation; this bug was real, below) | `map(sweepRows)` guard |
| 38 | SMD normalisation: null score not subtracted | normalisation test |

38 / 38 killed (25 on the code below on 2026-11-18; 26–38 added with the SMD harness, run on
2026-11-19 with the copy-based procedure).
Procedure: the script copies `src`, `test`, `bench` and `scripts` to a fresh scratch directory
(node_modules and the NAB data linked read-only), applies one mutant there, runs the named
tests with vitest's JSON reporter, and deletes the copy; the shared tree is only read.
`node scripts/mutants.mjs --verify-clean` checks the tree (every original present once, no
mutant text). **Disclosure:** the runs behind the table above applied mutants in place and
restored them (a full run ending 23:34:16 UTC, a two-mutant re-run, and the final full run
23:56:34–23:57:38 UTC on 2026-11-18); a snapshot of the tree taken then could contain one. The
script was changed to copies afterwards, per AGENTS.md, and `--verify-clean` reports the tree
clean.

## Benchmark: Numenta Anomaly Benchmark

### How it was produced

1. `bash bench/fetch-nab.sh --results` fetches from `raw.githubusercontent.com/numenta/NAB/master`
   (2026-11-18): the 58 data files (365,551 rows, 7 categories, 116 labelled windows),
   `combined_windows.json`, `combined_labels.json`, `profiles.json`, `thresholds.json`,
   `final_results.json`, NAB's `sweeper.py`, and the published per-row outputs of NAB's 15
   detectors reduced to their `anomaly_score` column. 68 MB under `bench/data/` (git-ignored).
   The commit could not be pinned (no GitHub API access here), so `bench/nab-manifest.json`
   records the SHA-256 of every data and label file, and `nab-run.ts` refuses to score if they differ.
2. **Scorer**: `bench/nab.ts` ports NAB's `sweeper.py`, `optimizer.py`, `scorer.py` and
   `runner.normalize` line by line (scaled sigmoid, first detection per window, FP weighting
   after a window, probation = min(⌊0.15 n⌋, 750), threshold sweep, normalisation by the null
   detector and the window count). Checked two ways: NAB's own `sweeper.py` on toy files gives
   identical numbers, and NAB's 15 published detectors re-scored from their per-row outputs give
   all 45 numbers of `final_results.json` to within 4.5e-11 (at NAB's stored thresholds; for 8
   of the 45 a fresh optimisation finds a better threshold than NAB's stored one).
3. `node --experimental-strip-types bench/nab-run.ts` (13 minutes) produces both protocols.
   The tables below are from the run on the final detector code (repeated twice with identical
   result tables; the later timestamp-range guard cannot affect NAB, whose timestamps are near
   1.4e12 ms):
   - **NAB protocol** (comparable with NAB's scoreboard, and optimistic): default parameters,
     continuous score s mapped to s/(1+s), every row ≥ the threshold a detection, threshold
     optimised per profile on the whole corpus — how NAB's published numbers were made.
   - **Held-out** (honest): files split in two folds, alternating within each category in path
     order (fold A: 31 files, fold B: 27; the split is in `bench/out/nab-results.json`). For each
     profile, every parameter including the detector's own threshold `k` is chosen on one fold
     (grids in `bench/adapters.ts`) and the detector is scored on the other, both ways; the two
     test halves are summed and normalised over the corpus. **Detections are alarm onsets** —
     the first point of each run of flagged points, what a monitor pages on. NAB's detectors are
     re-scored the same way from their outputs, as points (NAB's convention) and as onsets.
   - Every adapter is causal. Seasonality is detected on the probationary 15 % only (22 files
     seasonal: 21 daily or hourly, one weekly). STL is refit once per period on the trailing 4
     periods and new points scored against the stored model; PELT re-segments the trailing 576
     points every 12 points and reports a change when that run finds it.
   - The static threshold is set from the probationary period: [min − m·range, max + m·range].
4. Precision and recall are at the windows: recall = windows with a detection / windows; event
   precision = alarm events overlapping a window / all events. Delay = rows from the labelled
   anomaly to the first detection in its window (negative = before the label; windows start
   before the label).

### Results

NAB protocol (defaults, threshold over the whole corpus):

| detector | standard | low FP | low FN |
|---|---|---|---|
| threshold (probation range) | 5.2 | 4.2 | 9.8 |
| ewma | 0.0 | 0.0 | 13.6 |
| robust_z | 2.1 | 1.8 | 2.3 |
| seasonal (auto period, else robust z) | 2.1 | 1.8 | 2.3 |
| stl | 0.7 | 0.7 | 0.8 |
| cusum | 14.5 | 0.0 | 31.1 |
| pelt (rolling) | 4.2 | 2.9 | 4.8 |
| *NAB published, read from `final_results.json`:* | | | |
| null | 0.0 | 0.0 | 0.0 |
| random | 16.8 | 5.8 | 25.9 |
| windowedGaussian | 39.6 | 20.9 | 47.4 |
| relativeEntropy | 54.6 | 47.6 | 58.8 |
| skyline / twitterADVec | 35.7 / 47.1 | 27.1 / 33.6 | 44.5 / 53.5 |
| numenta (HTM) / ARTime | 70.1 / 74.9 | 63.1 / 65.2 | 74.3 / 80.4 |

Under NAB's own protocol, untuned z-type scores are near zero: one global threshold over
every row of every file ranks flat stretches and heavy-tailed bursts first (scores at the cap),
and every flagged row of a long run is a false positive. NAB's detectors emit scores built for
that protocol (likelihoods, saturating probabilities). The held-out table is the comparison
that matters.

Held-out (parameters and threshold chosen on the other fold; my detectors as alarm onsets;
NAB's as published points):

| detector | standard | low FP | low FN | window recall | event precision | median delay (rows) | chosen on fold A / B (standard) |
|---|---|---|---|---|---|---|---|
| **threshold** (counterfactual baseline) | 21.8 | 5.5 | 32.7 | 41 % | 24 % | 0 | m = 0.5 / m = 1 |
| ewma | **30.1** | 3.9 | 40.8 | 59 % | 22 % | −1 | half-life 100, k 8 / same |
| robust_z (MAD) | −105.9 | −282.4 | −45.6 | 75 % | 16 % | −8 | window 1000, k 10 / same |
| seasonal (MAD; robust z where no period) | −76.4 | −223.3 | −26.2 | 74 % | 15 % | −14 | k 9, robust |
| seasonal, daily forced | −104.1 | −274.8 | −45.8 | 71 % | 13 % | −8 | k 9 |
| stl (refit per period) | −352.2 | −795.4 | −203.5 | 94 % | 13 % | −56 | k 9 |
| cusum | 15.1 | −51.2 | 38.8 | 86 % | 15 % | −4 | k 1, h 20 |
| pelt (rolling) | −123.5 | −321.3 | −55.9 | 79 % | 12 % | −10 | minShift 8σ |
| *post hoc (added after seeing the rows above):* | | | | | | | |
| robust_z, k ∈ {15, 25, 40} | −5.1 | −40.7 | −4.7 | 40 % | 16 % | 0 | k 40 |
| seasonal, k ∈ {15, 25, 40} | 4.7 | −26.6 | 22.1 | 48 % | 20 % | −1 | k 40 / 25 |
| **robust_z, quantile spread** (99th pct.) | **44.8** | **33.7** | **52.3** | 67 % | 34 % | 0 | window 4000, k 1.5 / 2 |
| **seasonal, quantile spread** | **41.4** | 18.8 | 48.1 | 66 % | 27 % | −1 | 1 season, k 2, robust |
| *NAB's detectors through the same held-out protocol (points / onsets):* | | | | | | | |
| random | 15.5 / 16.1 | 5.9 / 5.9 | 25.1 / 26.5 | 36 % | 12 % | | |
| windowedGaussian | 39.6 / 43.5 | 20.9 / 28.5 | 41.7 / 45.0 | 63 % | 38 % | −1 | |
| skyline | 35.7 / 43.7 | 27.1 / 30.3 | 30.2 / 55.2 | 62 % | 37 % | −1 | |
| twitterADVec | 47.1 / 48.7 | 33.6 / 37.0 | 53.5 / 54.6 | 66 % | 43 % | 0 | |
| randomCutForest | 51.4 / 48.8 | 34.8 / 37.4 | 54.8 / 58.1 | 75 % | 40 % | 0 | |
| knncad | 52.9 / 54.5 | 43.4 / 43.4 | 61.4 / 62.5 | 78 % | 21 % | −2 | |
| relativeEntropy | 54.6 / 54.9 | 47.6 / 48.1 | 58.8 / 59.0 | 67 % | 58 % | 0 | |
| earthgeckoSkyline | 58.2 / 58.2 | 46.2 / 46.2 | 63.8 / 63.8 | 75 % | 29 % | −1 | |
| numenta (HTM) | 68.7 / 68.2 | 62.7 / 62.7 | 72.1 / 72.8 | 81 % | 55 % | 0 | |
| ARTime | 73.3 / 72.9 | 62.3 / 61.9 | 78.7 / 79.9 | 90 % | 43 % | 1 | |

By category (held-out, standard profile; `artificialNoAnomaly` has no windows, so its
normalised score is undefined — false-alarm rows there: 0 for threshold, EWMA, both quantile
variants and the MAD seasonal; 42 robust z, 51 STL, 132 CUSUM, 214 PELT; NAB's HTM 4, relativeEntropy 7):

| detector | artificial with anomaly | AWS CloudWatch | ad exchange | known cause | traffic | tweets |
|---|---|---|---|---|---|---|
| threshold | 15.5 | −12.3 | 47.5 | 21.9 | 13.1 | 46.8 |
| ewma | −70.5 | 29.2 | 55.3 | 5.3 | 36.4 | 50.3 |
| robust_z (MAD) | −55.4 | −261.6 | 60.1 | −321.6 | 59.9 | 17.0 |
| seasonal (MAD) | −6.3 | −257.6 | 49.7 | −111.5 | 51.8 | −12.3 |
| stl | −361.9 | −413.3 | 9.2 | −296.8 | 43.8 | −639.6 |
| cusum | −42.3 | 54.6 | 57.5 | −109.2 | 73.8 | 40.4 |
| pelt | −190.1 | −97.3 | 63.4 | −241.4 | 36.4 | −178.8 |
| robust_z, quantile (post hoc) | 14.6 | 40.2 | 59.0 | 19.2 | 71.7 | 51.7 |
| seasonal, quantile (post hoc) | **60.2** | 35.9 | 59.7 | 13.8 | 44.0 | 50.1 |
| NAB windowedGaussian | 2.6 | 31.2 | 56.9 | 13.4 | 64.3 | 51.4 |
| NAB relativeEntropy | 56.6 | 50.0 | 36.8 | 49.9 | 78.6 | 59.8 |
| NAB numenta (HTM) | 70.6 | 73.4 | 70.2 | 55.5 | 77.3 | 68.0 |

**With and without the seasonal baseline** (held-out, standard): on the 22 files where
seasonality was detected, seasonal-quantile 45.9 vs robust-z-quantile 47.3 (MAD versions
−106.5 vs −214.1); on the 36 others 38.9 vs 43.3. Per file, where the anomaly is a value wrong
for its phase, the seasonal baseline is the only one of mine that sees it:

| file | robust z (quantile) | seasonal (quantile) | threshold | ewma |
|---|---|---|---|---|
| art_daily_flatmiddle | missed (−1.00) | **detected (0.86)** | missed | missed |
| art_daily_jumpsdown | missed | **detected** | missed | missed |
| art_daily_nojump | missed | **detected** | missed | missed |
| art_daily_jumpsup | detected | detected | detected | missed |
| nyc_taxi (5 windows) | all missed (−5.00) | **0.09** (5 detection rows, 6 false) | all missed | all missed |
| ambient_temperature_system_failure (weekly) | both missed (−2.00) | **0.84** | −0.13 | −2.00 |

The synthetic test makes the same point: a daily-peak value at 18:00 is flagged by the seasonal
baseline and not by a robust z-score over the same day.

### What earns its place

- **Static threshold** (21.8): the counterfactual. Beats random (15.5).
- **EWMA** earns its place over the threshold (30.1 vs 21.8; recall 59 % vs 41 %), with a long
  half-life (100 points) and k = 8 chosen on both folds. It loses to the threshold in the low-FP
  profile (3.9 vs 5.5) and on the artificial anomalies (−70.5).
- **Robust z-score with MAD does not** (−105.9): on heavy-tailed series the MAD describes the
  bulk only. Example: `cpu_utilization_asg_misconfiguration` sits at 31–34 with a routine spike
  to ~46 every dozen points; each spike is ~20 robust σ, giving 1,293 alarm onsets at k = 10.
  A larger k (post hoc) only reaches −5.1. A Gaussian σ (EWMA, windowedGaussian) is inflated by
  the spikes and does not have this problem — a "simple beats robust" result in the spirit of
  TSB-AD's "simple beats complex".
- **Tail-aware spread** (post hoc): scaling by the 99th percentile of |x − median| over a long
  window (4,000 points) makes the robust z-score the best of mine (44.8 standard, 33.7 low FP,
  52.3 low FN; event precision 34 %), above windowedGaussian (39.6 published, 43.5 as onsets)
  and below relativeEntropy (54.6), HTM (68.7) and ARTime (73.3). Because the method was chosen
  after looking at this corpus, the number is optimistic by an unknown amount even though its
  parameters were chosen on the other fold. It needs confirming on data it has not seen (TSB-AD
  or viz's own) before it becomes the default; the code default is still the MAD.
- **Seasonal baseline**: not in aggregate on NAB (41.4 vs 44.8 without it), but decisively on
  phase-wrong anomalies (4/4 vs 1/4 artificial daily anomalies; nyc_taxi; the weekly ambient
  temperature file). NAB's files are about two weeks long, so k = 1 season was chosen; weekly
  seasonality with k = 4 is tested only synthetically.
- **STL residuals do not** as an alarm (−352.2): a 4-period fit, residual MAD tiny relative to
  bursts on count series (Twitter volumes: 2,554 onsets in 15,853 rows). The decomposition itself
  is verified against statsmodels and is the right tool for the scheduled job and for
  explanations; scoring its residuals with the quantile spread was not tried.
- **CUSUM does not** as a pager (15.1; recall 86 % but 1,704 events; in-control run length 195
  points on iid noise). Its value is the "mean shifted from A to B at T" explanation.
- **PELT does not** as an online alarm (−123.5). Offline it is exact (ruptures, brute force) and
  cheap (3.3 ms for 2,016 points): use it to annotate changes, not to page.
- **Burn rate and cross-series** cannot be scored on NAB (no SLO data, univariate); they are
  verified against the workbook and on synthetic groups.

## Second benchmark: SMD, with every parameter frozen on NAB

The question: do NAB's conclusions, above all the post hoc quantile spread, hold on data the
choice has never seen? Every number in this section was **measured on this machine**.

### Dataset and licence

**SMD, the Server Machine Dataset** (Su et al., "Robust Anomaly Detection for Multivariate Time
Series through Stochastic Recurrent Neural Network", KDD 2019): 28 machines of "a large Internet
company", 38 metrics each, "5-week-long", split in equal halves (train / test), with labels for
"whether a point is an anomaly and the dimensions [that] contribute to every anomaly" (verified:
the repository README). The 1-minute step and the labelling by domain experts from incident
reports are from the paper (training knowledge, not re-read here); the row counts fit the step
(2 × 28,479 rows = 39.6 days for machine-1-1). Real server metrics, which is what viz's ruler
watches. **Licence: MIT** — verified: the repository's `LICENSE`
(`github.com/NetManAIOps/OmniAnomaly`, "Copyright (c) 2021 NetManAIOps-OmniAnomaly"), read on
2026-11-19; its README gives no separate terms for the data, which sit in the same repository.
MIT allows this use. The data are fetched at run time (`bash bench/fetch-smd.sh`, 112 files,
464 MB) into `bench/data/smd/`, which is git-ignored; nothing from SMD is stored here, so
`THIRD_PARTY.md` is unchanged. `bench/smd-manifest.json` keeps the SHA-256 of every file.

Not chosen (training knowledge, not re-checked here): Yahoo S5 (Webscope terms, research use
only), the AIOps 2018 KPI set (no licence known), TSB-AD (bundles NAB itself and Yahoo).

### Order of work (no peeking)

1. `bench/freeze.ts` (2026-11-19T02:27:28Z) tuned every detector on **all of NAB** — the same
   grids as the held-out protocol, alarms as onsets, best NAB score per cost profile — and wrote
   `bench/smd-frozen.json`: the chosen configurations, the SMD protocol below, its hypotheses and
   decision rule, and the SHA-256 of `src/`, `bench/adapters.ts` and `bench/nab.ts`. It refuses
   to overwrite the file.
2. `bench/fetch-smd.sh` refuses to run before that file exists; SMD was first fetched at
   02:28:39Z (`bench/data/smd/FETCHED_AT`). `bench/smd-run.ts` refuses to score if the pinned
   code changed or if the data were fetched before the freeze, and records the hashes of the
   frozen file and of the scorer in its results.
3. Nothing was tuned on SMD. The scorer (`bench/smd.ts`) was written and its tests and mutants
   passed before any detector ran on SMD, and it was not changed afterwards.

Frozen configurations (standard / low FP / low FN where they differ; NAB score in sample, all
58 files, so above the held-out numbers):

| detector | configuration | NAB in sample (std / low FP / low FN) |
|---|---|---|
| threshold (probation range ± m·range) | m 0.5 / 1 / 0.5 | 29.1 / 17.7 / 36.0 |
| ewma | half-life 100, k 8 / 8 / 6 | 30.1 / 3.9 / 40.8 |
| robust_z (MAD) | window 1000, k 10 | −105.9 / −282.4 / −45.6 |
| seasonal (MAD; robust z where no period) | 1 season, k 9, robust | −65.8 / −202.8 / −18.9 |
| stl | k 9 | −352.2 / −795.4 / −203.5 |
| cusum | k 1, h 20 | 15.1 / −51.2 / 38.8 |
| pelt | minShift 8 | −123.5 / −321.3 / −55.9 |
| robust_z, MAD with k up to 40 (post hoc) | window 1000 / 1000 / 50, k 40 | −2.4 / −40.7 / 13.2 |
| seasonal, MAD with k up to 40 (post hoc) | 3 seasons, k 25 / 40 / 25 | 6.4 / −25.8 / 22.1 |
| **robust_z, quantile spread** | window 4000, k 2 / 2 / 1.5 | 46.8 / 33.7 / 55.6 |
| **seasonal, quantile spread** | 1 season, k 2 / 3 / 2, robust | 41.4 / 22.7 / 49.7 |
| random (trivial: each row flagged with probability p, data never read; mean of 5 seeds) | p 0.003 / 0.0001 / 0.003 | 8.7 / −0.5 / 23.8 |

`seasonal_daily` (a daily period forced where none is detected) was not run: it exists because
NAB's 750-row probation can be too short to detect a period; SMD's history is 2–3 weeks.

### Protocol (frozen with the configurations)

- **Series**: one per (machine, metric): the training half followed by the test half; a series
  constant over both halves is excluded. The **training half is history**: never scored, it is
  the adapters' probationary period (the static threshold's range, seasonality detection) and
  warms every detector, which runs causally over history and test. The whole test half is
  scored. Rows are 1 minute apart; parameters stay in points as chosen on NAB (mostly 5-minute
  data), so a 4,000-point window is 2.8 days here instead of 14: part of what is tested.
- **Labels**: a series' segments are the `interpretation_label` ranges that list its metric.
  The ranges' index convention was taken from agreement with `test_label` (0-based, end
  exclusive: 52 of 708,420 rows disagree; the next best convention 373).
- **Primary score: NAB's scorer**, unchanged (`bench/nab.ts`: scaled sigmoid, first detection
  per window, FP weighting, three cost profiles, normalised by the null detector and the window
  count), alarms as onsets, each profile with its own frozen configuration. **Windows** follow
  NAB's labeler (`windowLength = 0.1 · length / #anomalies`, centred on the anomaly) applied to
  segments: w = ⌊0.1 · nTest / k⌋ for a series with k segments, window = [start − ⌊w/2⌋,
  end + ⌊w/2⌋], clipped, overlaps merged. **Don't care**: a machine segment that does not list
  the metric, widened by 15 minutes, is not scored outside the series' own windows (the labels
  say the machine was anomalous, not whether this metric showed it). The same table without
  that rule ("strict") is in `bench/out/smd-results.md`.
- **Event metric** (simple, fixed tolerance): a segment is detected if an onset of its series
  lies in [start − 15 min, end + 15 min]; an onset is true if it lies in such a span, false
  otherwise (onsets in don't-care spans excluded); precision, recall and F1 pooled over the
  corpus. 15 minutes: about a `for: 5m` plus two evaluation intervals; not varied.
- **Machine view** (secondary, what a page per machine would see): a machine is flagged while
  any of its series is; onsets of that union against the `test_label` runs, same tolerance,
  and false onsets per machine-day.
- **Uncertainty**: paired bootstrap over the 28 machines (2,000 resamples, seed 20261119),
  95 % percentile intervals for differences against EWMA and the threshold.
- **Decision rule**, written before: the quantile spread *generalises* if, standard profile, its
  score exceeds EWMA's and the threshold's, its event F1 exceeds EWMA's, and the interval of
  its score minus EWMA's lies above 0; point estimates in favour with an interval including 0:
  *not confirmed*; otherwise *does not generalise*.
- **Exact speed-ups** (checked at run time): the robust z family runs from windowPoints + 8
  points before the test half (its state is the trailing window), and configurations differing
  only in k share one call (a point is anomalous iff ok and score > k). On the first series of
  every machine both are compared with the plain adapter over the whole series; any difference
  aborts the run.

### Results on SMD

`bash bench/fetch-smd.sh && node --experimental-strip-types bench/smd-run.ts` (two passes of two
processes, `--only` and `--machines`, about 3 h on 4 shared cores at load 10–17; then `--score`,
90 s). 28 machines, 889 series (175 constant ones excluded), 44.9 million points, 492
machine-days of test data, 2,329 labelled segments in 2,189 windows; seasonality found on the
history: daily 394, weekly 84, hourly 34, none 377. The grouped robust z runs matched the plain
adapter on every machine's first series. Tables: `bench/out/smd-results.md`.

NAB's scorer, alarms as onsets, each profile with its frozen configuration; next to NAB's
held-out numbers from the table above. Intervals: 95 %, machine bootstrap.

<!-- SMD-TABLE-1 -->

Event metric (standard configuration, ±15 minutes), the NAB-window view, and the machine view:

<!-- SMD-TABLE-2 -->

### What held and what did not

<!-- SMD-HYPOTHESES -->

- **The quantile spread generalised.** By the rule written before scoring, both variants pass:
  robust z with the quantile spread scored 42.8 on SMD against 44.8 held out on NAB (first on
  both), above EWMA by 32.4 [20.7, 48.7] and the threshold by 26.3 [15.6, 35.0], event F1 0.441
  against 0.206 and 0.328; it led EWMA on 25 of 28 machines and the threshold on 17. The seasonal
  variant: 35.5 (NAB 41.4), second on both. It is the spread, not a larger k: the MAD with k up
  to 40 scored −78.7. Without the don't-care rule ("strict") the order is the same (39.5, 31.6,
  threshold 15.9, EWMA 6.3).
- **EWMA did not.** 10.4 against NAB's 30.1, below the static threshold in all three profiles
  (standard −6.0 [−30.9, 10.5], low FP −53.9 [−100.8, −21.9]) and in event F1 (0.206 against
  0.328, interval excluding 0): 12 % of its alarms are near a labelled segment, about 30 false
  alarm onsets per machine-day. NAB's EWMA > threshold (H3) was a NAB result. Its frozen
  parameters were the largest of the grid (half-life 100, k 8), and 100 points is 100 minutes
  here: the rule is more nervous at 1-minute steps than at 5.
- **The static threshold held up best where false alarms cost most**: in the low-FP profile
  only the two quantile variants scored above it, by intervals that include 0 (+7.5 [−8.8,
  19.7], +5.5 [−11.7, 18.5]); per machine it raised 1.5 unmatched alarm onsets a day (0.5 with
  the low-FP level, m = 1, at 76 % precision) against 11.5 for the quantile spread. It misses
  more (event recall 26 % against 62 %).
- **The MAD spread failed again, worse**: robust z −318.2, seasonal −382.8, below the trivial
  random detector; CUSUM fell from 15.1 to −147.6 (about 125 false alarm onsets per
  machine-day).
- **The trivial random detector** scored −68.0: its frozen rate (0.003 a row) is per row, and an
  SMD series has four times NAB's rows. <!-- RANDOM-BEATEN -->
- **Seasonality did not pay in aggregate here either** (35.5 against 42.8 without it, as on
  NAB), though 478 of 889 series had a daily or weekly period found in their history. Why was
  not measured (SMD's labels do not say which anomalies are wrong only for their time of day).

### Proposed amendment to D33 (for the ruler's owner; not applied)

`design/DECISIONS.md` and `ruler/` are not changed here. What the evidence above supports:

1. **Non-paging default: robust z with the quantile spread** (99th percentile of |x − median|,
   k 2, window 4,000 points), severity `ticket`, replacing EWMA. This is D33's own condition
   ("the quantile spread holds its score on data it has not seen ... then it becomes the
   default for non-paging rules"), met under a rule fixed in advance.
   **Blocker in the ruler, today**: `estimateStateBytes` puts robust z at 36 bytes a point, so
   4,000 points is about 145 KB per series, over `maxAnomalyStateBytesPerSeries` (64 KiB); the
   save would refuse it. And the ruler rewrites every series' whole state each tick (about
   14.5 MB a tick at 100 series). Choices for the owner: (a) store the window incrementally
   (append a point and drop the oldest per tick, blocks of rows) and raise the limit for this
   detector; (b) a smaller window: 1,000 points (about 37 KB) scored 40.4 on NAB in sample
   against 46.8, and <!-- POSTHOC-1000 --> on SMD — **post hoc**, chosen after the frozen
   results, so it is not independently confirmed; (c) the window in time on 5-minute rollups
   (4,000 points = 14 days, NAB's span), which SMD did not test.
2. **EWMA stops being a default**; it stays available, warned with both numbers (NAB 30.1, SMD
   10.4: below a static threshold on SMD in every profile).
3. **Pages stay on the static threshold** with a level the author gives: it beat EWMA in the
   low-FP profile on both benchmarks, the quantile spread's low-FP lead over it is not
   significant on SMD, and it raised about an eighth of the quantile spread's false alarms per
   machine. (Unchanged from D33.)
4. **Naming `robust_z` or `seasonal` without a spread gets the quantile spread**; the MAD only on
   request, with the warning quoting NAB (−105.9 / −76.4) and SMD (−318.2 / −382.8). The
   seasonal baseline stays opt-in, for values wrong for their time of day (its one strength on
   NAB; not separately measurable on SMD's labels). Its daily state at a 1-minute interval is
   about 59 KB a series, near the same limit.
5. **CUSUM** unchanged (`info`, may not page); its warning should quote SMD's −147.6 next to
   NAB's 15.1. STL and PELT stay out of rules (<!-- STL-PELT -->).
6. The guide's numbers in `ruler/src/anomaly.ts` are copied from this README (contract issue 1)
   and change with this.
7. D33's "would change if" then becomes: viz's own labelled incidents rank the detectors
   differently; a third benchmark or viz's data contradicts SMD; or the state cost of a
   4,000-point window cannot be brought within the ruler's limits (then the next best
   evidenced choice is the smaller window, at a lower score).

## Costs (measured here, Node 22.23; CPU time, `bench/cpu.ts`)

| detector | batch, µs CPU per 1,000 points | one tick through JSON state, µs | state, bytes | cold-start history | class per tick / cold start |
|---|---|---|---|---|---|
| threshold | 588 (explanations for many anomalies) | 6.3 | 57 | none | tail / tail |
| ewma | 137 | 8.9 | 116 | 5 h at 5 min | tail / recent |
| robust_z (288 points) | 3,618 | 193 | 9,370 | 1 d | tail / rollup |
| seasonal, daily at 5 min, k = 4 | 9,828 | 523 | 26,785 | 5 d | tail / rollup |
| seasonal, weekly at 1 h, k = 4 | 5,845 | 285 | 15,672 | 35 d | tail / rollup |
| burn rate, workbook rules, 1-min buckets | 22,594 | 1,678 | 67,329 | 3 d | tail / rollup |
| burn rate, workbook rules, 5-min buckets | 7,106 | 348 | 13,540 | 3 d | tail / rollup |
| cusum | 605 | 21 | 655 | 5 h | tail / recent |
| stl, scoring against a stored model | 365 | 92 | 5,739 | 2 d | rollup / rollup |

| batch job | ms CPU per run |
|---|---|
| STL fit, 8 days at 5 min (2,304 points), daily | 33.5 |
| STL fit, 8 weeks at 1 h (1,344 points), weekly | 13.3 |
| PELT, 1 day / 7 days at 5 min | 0.35 / 3.3 |
| seasonality detection, 7 days at 5 min / 5 weeks at 1 h | 0.96 / 0.29 |
| cross-series, 50 members, one timestamp | 0.003 |

"One tick" is the Durable Object pattern if state were parsed and serialised every tick: it is
dominated by JSON (robust z: 3.6 µs of detection, ~190 µs of JSON). Keeping state in memory
(Integration) costs the batch figure per point. On the NAB corpus (365,558 points, default
configs, including adapter work), CPU per 1,000 points: threshold 0.37 ms, EWMA 0.50, CUSUM
0.69, robust z 2.95, seasonal 4.86, STL with a refit per period 44.8, rolling PELT 50.3.
These are Node numbers, not Workers numbers; the Workers CPU price per tick is modelled from
them, not measured.

A performance finding on the way: in this V8, `x ** 3` in STL's LOESS weights cost about
350 ns against 6 ns for `x * x * x` (measured), which made one STL fit 430 ms instead of 34 ms.

## Not implemented

- **Log-template frequency shift** (design §7 tier 1): needs Drain template ids from ingest;
  the detectors here would apply to per-template counts, but nothing reads templates.
- **Tier 2** foundation models; **MSTL** (several seasonalities at once), Holt-Winters, BOCPD;
  quantile sketches (DDSketch) as baselines — the seasonal baseline keeps raw values.
- **In the ruler**: cross-series rules, scheduled STL refits and PELT runs ("Integration").
  Warming from history and SLO burn-rate rules are built (ruler parts 10 and 11, D42, D43).
- **A workerd run of this package's own tests**: `src/` is checked to use no Node API and the
  bundle runs in a bare `node:vm` context with `Date.now`/`Math.random` poisoned. The detectors
  do run in workerd inside the ruler (its tests and `npm run bench:anomaly`), but this package's
  property tests run in Node only.
- **A third benchmark** (TSB-AD's non-NAB sets, Exathlon) or viz's own labelled incidents; the
  SMD event tolerance (15 minutes) and window rule were not varied; the post hoc smaller
  windows were scored once and are not confirmed elsewhere. NAB's own Python runner was not run
  end to end (its `sweeper.py` was; its runner needs the old detector stack); the TypeScript
  port reproduces all 45 published numbers.
- **STL residuals with the quantile spread**; seasonal baseline with a trend term; an
  automatic per-series choice between MAD and quantile spread.
- **Burn rate**: no OpenSLO input; no recording-rule generation (Sloth/Pyrra style), by
  decision (D42): the ruler's SLO rules judge their own bucket rings with `evaluateWindows`.
- **Explanations** are English and UTC only.

## Risks

- **Fixed-k bands do not transfer across series.** NAB's main lesson here, confirmed on SMD: a
  k chosen on one set of files floods on heavy-tailed or quantised series (the MAD variants
  scored −318 and −383 on SMD). Per-series calibration, a tail-aware spread, `minDeviation`, and
  onset semantics with `for` are the mitigations; the library's default spread is still the MAD
  the design names (changing it is part of the proposed amendment).
- **Two benchmarks, not viz's data.** SMD is one company's servers (28 machines) and its labels
  come with the dataset; the don't-care rule and the 15-minute tolerance are single choices.
  Parameters are in points: the SMD result is for 1-minute steps, NAB's for mostly 5-minute.
- **`sweepRows` has an optional second argument** (the probation), added for SMD. Passed to
  `.map()` it receives the index: `nab-run.ts`, `verify-scorer.ts` and a test did exactly that
  after the change, until that test failed (neither script was run in that state; the freeze
  called it correctly). A test now
  rejects `.map(sweepRows)` in `bench/` and `test/`; elsewhere it is still a trap.
- **CUSUM false alarms**: 195 points between false alarms on iid noise with estimated
  parameters; autocorrelated metrics alarm far more often.
- **State write cost.** The ruler persists state every tick, as whole batches per row (one row
  per rule per tick at 100 EWMA series; 6 for 100 daily seasonal series, whose state is 27 KB
  each): weekly seasonality belongs on 1-hour rollups.
- **Cold start**: seasonal rules need k periods of rollups (35 days for weekly, k = 4) or they
  stay `warming`; robust z over a day reads a day of history on every cold start (`rollup`).
  The ruler now reads that history at a new rule's first tick (D43), but only under its warm-up
  budget (3,000,000 samples): a rule whose look-back is over it, or whose warm-up fails three
  times, still warms live for that long, and says so in its status.
- **Incremental ≡ batch holds only with an explicit `stepMs`** (an inferred step depends on the
  first batch).
- **Floating-point limits**: values beyond ±1e150 and timestamps beyond ±8.64e15 ms are
  missing; scale invariance holds for values whose squares do not underflow (|x| > 1e-100 in
  the property tests).
- **NAB fetched from `master`**: if upstream changes, `nab-run.ts` refuses to run against the
  manifest rather than silently producing different numbers.
- **The benchmark adapters are part of the result**: STL refit per period on 4 periods and PELT
  every 12 points are choices; other schedules would score differently.
