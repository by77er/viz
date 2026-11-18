/**
 * Stable series colours.
 *
 * Each series gets a palette slot from a hash of its label set, so the same series has the
 * same colour on every panel and after every reload. The palette is a fixed, colour-blind
 * validated set of eight hues with separately chosen light and dark steps (never generated
 * hues). When two series in one result hash to the same slot, the later one (in sorted key
 * order) moves to the next free slot; once all eight are in use, slots repeat with a dash
 * pattern as the secondary encoding so identity is never carried by hue alone.
 */

export const PALETTE_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'] as const
export const PALETTE_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'] as const
export const SLOT_COUNT = PALETTE_LIGHT.length

/** Dash patterns by "round": solid, dashed, dotted, dash-dot. */
export const DASHES: readonly (readonly number[])[] = [[], [6, 3], [2, 3], [8, 3, 2, 3]]

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
  /** Palette slot, 0..7. */
  slot: number
  /** Index into DASHES. */
  dash: number
}

/**
 * Assign a style to every series key. Deterministic in the *set* of keys (input order does
 * not matter). A series that is alone on its preferred slot always keeps it.
 */
export function assignStyles(keys: readonly string[]): Map<string, SeriesStyle> {
  const sorted = [...new Set(keys)].sort()
  const used = new Array<number>(SLOT_COUNT).fill(0)
  const out = new Map<string, SeriesStyle>()
  for (const key of sorted) {
    const pref = preferredSlot(key)
    // Least-used slot, scanning from the preferred one.
    let slot = pref
    for (let i = 0; i < SLOT_COUNT; i++) {
      const s = (pref + i) % SLOT_COUNT
      if (used[s]! < used[slot]!) slot = s
    }
    out.set(key, { slot, dash: used[slot]! % DASHES.length })
    used[slot]!++
  }
  return out
}

export function slotColor(slot: number, dark: boolean): string {
  return (dark ? PALETTE_DARK : PALETTE_LIGHT)[slot % SLOT_COUNT]!
}
