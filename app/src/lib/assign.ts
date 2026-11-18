/**
 * Which series of a result get a colour, and which colour (design review M2).
 *
 * The rule itself belongs to the design system and is being revised; this module is the
 * mechanism, with the rule as a parameter (`AssignPolicy`):
 *
 * (a) a series that already has a slot in this view keeps it (`previous`), so a filter that
 *     removes other series does not repaint the survivors;
 * (b) free slots are given out in palette order (slot 0 is `series-1`) to the series that
 *     have none, in the order they appear in the result;
 * (c) when more series want a slot than are free, they are ranked by a size measure (the
 *     policy's `measure`, by default the mean over the result's range; ties by name) and the
 *     top ones get the free slots. The rest fold into ONE group, "Other": its members, and
 *     either nothing to draw (`other: 'list'`, the default: listed, not drawn) or their sum
 *     (`other: 'sum'`, only right for values that add up);
 * (d) the result is a pure function of (series, previous, policy): the same result and the
 *     same remembered assignment always give the same colours.
 */
export const SLOTS = 8

export interface AssignInput {
  /** Canonical identity of the series (lib/series seriesKey). */
  key: string
  name: string
  values: readonly (number | null)[]
}

export interface Ranked {
  key: string
  name: string
  /** The policy's size measure; null when the series has no values. */
  size: number | null
}

export interface AssignPolicy {
  /** How many series may have a colour. */
  slots: number
  /** The size of a series, for ranking. */
  measure: (values: readonly (number | null)[]) => number | null
  /** Sort order of candidates for a free slot: negative when `a` goes first. */
  compare: (a: Ranked, b: Ranked) => number
  /** What the Other group carries for drawing: nothing, or the sum of its members. */
  other: 'list' | 'sum'
}

/** Series key to slot, 0-based. What a view remembers between results. */
export type Assignment = Readonly<Record<string, number>>

export interface OtherGroup {
  /** Keys of the folded series, best ranked first. */
  members: string[]
  /** One value per x for drawing the group as a single series; null when the policy only lists the members. */
  combined: (number | null)[] | null
}

export interface Assigned {
  /** The slots now held: pass it back as `previous` for the next result of the view. */
  assignment: Assignment
  /** Keys with a slot, in result order. */
  coloured: string[]
  other: OtherGroup | null
}

export function meanOf(values: readonly (number | null)[]): number | null {
  let sum = 0
  let n = 0
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue
    sum += v
    n++
  }
  return n === 0 ? null : sum / n
}

/** Largest first; series without values last; ties by name, then by key. */
export function bySizeThenName(a: Ranked, b: Ranked): number {
  if (a.size !== b.size) {
    if (a.size === null) return 1
    if (b.size === null) return -1
    return b.size - a.size
  }
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

export const DEFAULT_POLICY: AssignPolicy = { slots: SLOTS, measure: meanOf, compare: bySizeThenName, other: 'list' }

export function assignSeries(series: readonly AssignInput[], previous: Assignment | null, policy: AssignPolicy = DEFAULT_POLICY): Assigned {
  const unique: AssignInput[] = []
  const seen = new Set<string>()
  for (const s of series) {
    if (seen.has(s.key)) continue
    seen.add(s.key)
    unique.push(s)
  }

  // (a) survivors keep their slot.
  const slotOf = new Map<string, number>()
  const taken = new Set<number>()
  for (const s of unique) {
    const slot = previous && Object.prototype.hasOwnProperty.call(previous, s.key) ? previous[s.key] : undefined
    if (slot === undefined || !Number.isInteger(slot) || slot < 0 || slot >= policy.slots || taken.has(slot)) continue
    slotOf.set(s.key, slot)
    taken.add(slot)
  }

  // (b), (c) the rest take the free slots, in palette order by appearance; ranked when there are too many.
  const free: number[] = []
  for (let i = 0; i < policy.slots; i++) if (!taken.has(i)) free.push(i)
  const candidates = unique.filter((s) => !slotOf.has(s.key))
  let folded: AssignInput[] = []
  if (candidates.length <= free.length) {
    candidates.forEach((s, i) => slotOf.set(s.key, free[i]!))
  } else {
    const ranked = candidates
      .map((s) => ({ s, r: { key: s.key, name: s.name, size: policy.measure(s.values) } }))
      .sort((a, b) => policy.compare(a.r, b.r))
    const chosen = new Set(ranked.slice(0, free.length).map((x) => x.s.key))
    let next = 0
    for (const s of candidates) if (chosen.has(s.key)) slotOf.set(s.key, free[next++]!)
    folded = ranked.slice(free.length).map((x) => x.s)
  }

  let other: OtherGroup | null = null
  if (folded.length > 0) {
    let combined: (number | null)[] | null = null
    if (policy.other === 'sum') {
      const n = folded.reduce((m, s) => Math.max(m, s.values.length), 0)
      combined = new Array<number | null>(n).fill(null)
      for (const s of folded) {
        for (let i = 0; i < s.values.length; i++) {
          const v = s.values[i]
          if (v != null && Number.isFinite(v)) combined[i] = (combined[i] ?? 0) + v
        }
      }
    }
    other = { members: folded.map((s) => s.key), combined }
  }

  const assignment: Record<string, number> = {}
  const coloured: string[] = []
  for (const s of unique) {
    const slot = slotOf.get(s.key)
    if (slot === undefined) continue
    assignment[s.key] = slot
    coloured.push(s.key)
  }
  return { assignment, coloured, other }
}

const STORE = 'viz.explore.assignment'

/** The assignment this browser tab last showed, so a reload and a filter change keep the colours. */
export function loadAssignment(storage: Pick<Storage, 'getItem'> | undefined = safeSession()): Assignment | null {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(STORE) ?? 'null')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out[k] = v
    return out
  } catch {
    return null
  }
}

export function saveAssignment(assignment: Assignment, storage: Pick<Storage, 'setItem'> | undefined = safeSession()): void {
  try {
    storage?.setItem(STORE, JSON.stringify(assignment))
  } catch {
    // Without storage the colours are still a pure function of the result.
  }
}

function safeSession(): Storage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage
  } catch {
    return undefined
  }
}
