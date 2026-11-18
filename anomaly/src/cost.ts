/**
 * Cost class of an anomaly rule from the history its detector declares, with the same
 * thresholds and names as the ruler's PromQL classification (ruler/src/classify.ts:
 * `tail` if it fits the shards' hot window, `recent` up to a day, else `rollup`).
 *
 * A detector with persisted state reads only new points each tick, so its *tick* class is
 * set by `tickLookbackMs`; its *cold-start* class (first evaluation, or after state is lost)
 * by `lookbackMs`. Both are returned; the ruler should show the tick class and budget for the
 * cold start.
 */
import type { HistoryNeed } from './types.ts'
import { duration } from './explain.ts'

export type CostClass = 'tail' | 'recent' | 'rollup'

export interface ClassifyConfig { hotWindowMs: number; recentWindowMs: number }

/** The ruler's defaults (ruler/src/classify.ts DEFAULT_CLASSIFY), copied, not imported. */
export const DEFAULT_CLASSIFY: ClassifyConfig = { hotWindowMs: 10 * 60_000, recentWindowMs: 24 * 3_600_000 }

const classOf = (ms: number, c: ClassifyConfig): CostClass => (ms <= c.hotWindowMs ? 'tail' : ms <= c.recentWindowMs ? 'recent' : 'rollup')

export function classify(need: HistoryNeed, intervalMs: number, config: ClassifyConfig = DEFAULT_CLASSIFY): { tick: CostClass; coldStart: CostClass; reason: string } {
  const tickMs = need.incremental ? Math.max(intervalMs, need.tickLookbackMs) : Math.max(intervalMs, need.lookbackMs)
  const tick = classOf(tickMs, config)
  const coldStart = classOf(need.lookbackMs + intervalMs, config)
  const reason = need.incremental
    ? `Reads ${duration(tickMs)} per tick from persisted state (${tick}); a cold start reads ${duration(need.lookbackMs)} (${coldStart}). ${need.reason}`
    : `Reads ${duration(tickMs)} each run (${tick}). ${need.reason}`
  return { tick, coldStart, reason }
}
