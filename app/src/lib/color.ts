/**
 * Stable series colours, restricted to the design system's eight chart tokens.
 *
 * Each series prefers a slot from a hash of its label set, so the same series has the same
 * colour on every panel and after every reload. Slots are the tokens `series-1` to
 * `series-8`, in that fixed order; the values live in the design system, not here. When two
 * series in one result hash to the same slot, the later one (in sorted key order) moves to
 * the next free slot.
 *
 * A result has at most eight coloured series. The design system's rule is that a ninth
 * series folds into "Other": the first eight series in sorted key order take the eight
 * slots, and every later one gets `slot: null`. The view draws those in a neutral ink and
 * names them "Other". Their values are not summed: a sum would be wrong for quantiles and
 * ratios.
 */

export const SLOT_COUNT = 8

/** CSS custom property that holds a slot's colour in the current theme. */
export function slotToken(slot: number | null): string {
  return slot === null ? '--ink-muted' : `--series-${(slot % SLOT_COUNT) + 1}`
}

/** FNV-1a, 32-bit, over UTF-16 code units. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** The slot a series prefers, independent of what else is on the chart. */
export function preferredSlot(key: string): number {
  return hashString(key) % SLOT_COUNT
}

export interface SeriesStyle {
  /** Token slot, 0..7 (`series-1`..`series-8`), or null when the series is folded into Other. */
  slot: number | null
}

/**
 * Assign a style to every series key. Deterministic in the *set* of keys (input order does
 * not matter). A series that is alone on its preferred slot always keeps it.
 */
export function assignStyles(keys: readonly string[]): Map<string, SeriesStyle> {
  const sorted = [...new Set(keys)].sort()
  const used = new Array<boolean>(SLOT_COUNT).fill(false)
  const out = new Map<string, SeriesStyle>()
  sorted.forEach((key, n) => {
    if (n >= SLOT_COUNT) {
      out.set(key, { slot: null })
      return
    }
    // The first free slot, scanning from the preferred one.
    let slot = preferredSlot(key)
    while (used[slot]) slot = (slot + 1) % SLOT_COUNT
    used[slot] = true
    out.set(key, { slot })
  })
  return out
}
