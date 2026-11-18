/**
 * COPIED VERBATIM from app/mock/ (storage.ts) for the deterministic fake query service.
 * mcp/ never imports app/; keep this copy unchanged so the fake answers as the app's mock does.
 */
/** Storage abstraction the mock evaluator reads from. Times are epoch seconds. */

export type Labels = Record<string, string>

export interface Sample {
  t: number
  v: number
}

export interface SeriesSource {
  labels: Labels
  /** Samples with `fromExclusive < t <= toInclusive`, ascending. */
  samples(fromExclusive: number, toInclusive: number): Sample[]
  /** The newest sample in the same window, if any. */
  latest(fromExclusive: number, toInclusive: number): Sample | undefined
}

export interface Storage {
  all(): SeriesSource[]
  metadata(): Record<string, { type: string; help: string; unit: string }[]>
}

/** Explicit samples; used by tests to check the evaluator against hand-computed results. */
export function memorySeries(labels: Labels, samples: [number, number][]): SeriesSource {
  const data = samples.map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t)
  return {
    labels,
    samples: (from, to) => data.filter((s) => s.t > from && s.t <= to),
    latest: (from, to) => {
      for (let i = data.length - 1; i >= 0; i--) {
        const s = data[i]!
        if (s.t <= to) return s.t > from ? s : undefined
      }
      return undefined
    },
  }
}

export function memoryStorage(series: SeriesSource[]): Storage {
  return { all: () => series, metadata: () => ({}) }
}
