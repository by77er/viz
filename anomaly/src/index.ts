/**
 * @viz/anomaly — pure anomaly detectors for the viz ruler (design §7).
 * No I/O, no clock, no randomness; runs in Workers, Durable Objects and Node.
 */
export * from './types.ts'
export { MAD_TO_SIGMA, MEANAD_TO_SIGMA, median, robust, inferStep } from './stats.ts'
export { fmt, duration, time } from './explain.ts'
export { stateBytes, type CommonParams } from './base.ts'

export { threshold, thresholdDefaults, type ThresholdParams, type ThresholdState } from './detectors/threshold.ts'
export { ewma, ewmaDefaults, type EwmaParams, type EwmaState } from './detectors/ewma.ts'
export { robustZ, robustZDefaults, type RobustZParams, type RobustZState } from './detectors/robustz.ts'
export { seasonal, seasonalDefaults, type SeasonalParams, type SeasonalState } from './detectors/seasonal.ts'
export {
  burnRate, burnDefaults, evaluateWindows, explainRule, SRE_WORKBOOK_RULES,
  budgetConsumed, burnRateFor, timeToExhaustionMs, errorRatioFor, detectionTimeMs, ruleDetectionTimeMs, resetTimeMs,
  type BurnParams, type BurnRule, type BurnSeries, type BurnState, type RuleResult, type WindowAggregate,
} from './detectors/burnrate.ts'
export { detectSeasonality, seasonalityDefaults, HOUR_MS, DAY_MS, WEEK_MS, type SeasonalityParams, type SeasonalityResult } from './detectors/seasonality.ts'
export { stl, stlDefaults, stlDecompose, fitStl, type StlParams, type StlModel, type StlOptions } from './detectors/stl.ts'
export { cusum, cusumDefaults, type CusumParams, type CusumState } from './detectors/cusum.ts'
export { peltDetector, pelt, peltDefaults, type PeltParams, type Segmentation } from './detectors/pelt.ts'
export { detectGroup, detectGroupWindow, groupDefaults, type GroupParams, type GroupResult, type GroupWindowParams, type MemberPoint } from './detectors/crossseries.ts'
export { classify, type CostClass, type ClassifyConfig, DEFAULT_CLASSIFY } from './cost.ts'

import { threshold } from './detectors/threshold.ts'
import { ewma } from './detectors/ewma.ts'
import { robustZ } from './detectors/robustz.ts'
import { seasonal } from './detectors/seasonal.ts'
import { burnRate } from './detectors/burnrate.ts'
import { stl } from './detectors/stl.ts'
import { cusum } from './detectors/cusum.ts'
import { peltDetector } from './detectors/pelt.ts'

/** Every single-series detector, by name. */
export const DETECTORS = { threshold, ewma, robust_z: robustZ, seasonal, burn_rate: burnRate, stl, cusum, pelt: peltDetector } as const
