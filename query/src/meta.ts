/**
 * The label endpoints over leaves (CARDINALITY.md "What is left" 3; 2026-11-19): putting
 * listings together exactly as one place lists them.
 *
 * The engine sorts names and values by their UTF-8 bytes and label sets pair by pair
 * (`engine/query` `meta`); JavaScript's `<` compares UTF-16 units, which disagrees above
 * U+FFFF, so the comparisons here are by code point (which is UTF-8 byte order).
 */

/** Code-point order, which is UTF-8 byte order. */
export function byCodePoint(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a.codePointAt(i)!
    const y = b.codePointAt(i)!
    if (x !== y) return x - y
    if (x > 0xffff) i++
  }
  return a.length - b.length
}

const pairs = (o: Record<string, string>): [string, string][] => Object.entries(o).sort((x, y) => byCodePoint(x[0], y[0]))

/** Label sets in the engine's order: their pairs sorted by name, compared name then value, pair by pair; a prefix first. */
export function byLabels(a: Record<string, string>, b: Record<string, string>): number {
  const pa = pairs(a)
  const pb = pairs(b)
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const c = byCodePoint(pa[i]![0], pb[i]![0]) || byCodePoint(pa[i]![1], pb[i]![1])
    if (c !== 0) return c
  }
  return pa.length - pb.length
}

/**
 * What one or more listings of a label call add up to: names or values (a set of strings) or
 * label sets, and per `match[]` set the `series_id`s of the series listed (so that a series
 * listed by two calls, from two waves of files, counts once). `json()` is what one place
 * answers for the same series: the sorted list.
 */
export class Listing {
  private readonly strings = new Set<string>()
  private readonly sets = new Map<string, Record<string, string>>()
  private readonly ids: Set<bigint>[] = []

  constructor(readonly kind: 'names' | 'values' | 'series') {}

  add(out: { json: string; ids: ArrayLike<bigint>[] }): void {
    if (this.kind === 'series') for (const o of JSON.parse(out.json) as Record<string, string>[]) this.sets.set(JSON.stringify(pairs(o)), o)
    else for (const s of JSON.parse(out.json) as string[]) this.strings.add(s)
    for (let i = 0; i < out.ids.length; i++) {
      const into = (this.ids[i] ??= new Set())
      const list = out.ids[i]!
      for (let k = 0; k < list.length; k++) into.add(list[k]!)
    }
  }

  /** Distinct series listed, per `match[]` set. */
  counts(): number[] {
    return this.ids.map((s) => s.size)
  }

  json(): string {
    if (this.kind === 'series') return JSON.stringify([...this.sets.values()].sort(byLabels))
    return JSON.stringify([...this.strings].sort(byCodePoint))
  }
}
