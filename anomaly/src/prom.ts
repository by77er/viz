/**
 * From the engine's Prometheus-shaped results (contracts/engine.ts) to detector input.
 * Pure; type-only import of the contract.
 *
 * Prometheus result times are Unix seconds as floats; detectors take milliseconds. Values
 * are strings: "NaN", "+Inf" and "-Inf" become non-finite numbers, which every detector
 * treats as missing. Query results never contain staleness markers (contracts/engine.ts),
 * so a series that stopped simply has no more points: a gap, not zeros.
 */
import type { PromMatrix, PromVector } from '../../contracts/engine'
import type { Series } from './types.ts'

const num = (s: string): number => (s === '+Inf' ? Infinity : s === '-Inf' ? -Infinity : Number(s))

/** One `Series` per matrix row, with its labels. */
export function seriesFromMatrix(m: PromMatrix): { labels: Record<string, string>; series: Series }[] {
  return (m?.result ?? []).map((r) => {
    const n = r.values.length
    const ts = new Float64Array(n)
    const values = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      ts[i] = Math.round(r.values[i]![0] * 1000)
      values[i] = num(r.values[i]![1])
    }
    return { labels: r.metric, series: { ts, values } }
  })
}

/** Members of a group for `detectGroup`, from an instant vector; `id` names each member by its labels. */
export function membersFromVector(v: PromVector, id: (labels: Record<string, string>) => string = (l) => JSON.stringify(l)): { id: string; value: number; labels: Record<string, string> }[] {
  return (v?.result ?? []).map((r) => ({ id: id(r.metric), value: num(r.value[1]), labels: r.metric }))
}
