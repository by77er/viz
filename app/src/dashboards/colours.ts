/**
 * One colour per series identity across a dashboard (D-M2 of the third design review; a proposal
 * for the design system's owner, who defines colour assignment: README, "Decisions").
 *
 * The system's chart keeps one colour map per view ("A view owns a map"), and every panel of a
 * dashboard is a view of its own, so each panel handed out its slots largest first by itself and
 * one service had three colours on one page. Here the dashboard keeps one map of its own, by
 * series identity (the label set without `__name__`, so `pod_cpu_usage_cores{pod="a"}` and
 * `pod_memory_working_set_bytes{pod="a"}` are one pod), in groups of the same label names (a
 * service, a pod and a route are different things and never compete for a slot). The first time
 * a panel is drawn in this tab, its eight largest series are coloured, each in the slot its
 * identity has on the dashboard when no larger series of the panel has that slot, else in the
 * next free one; the rest are Other, so a panel never starts with a series in Other that is larger
 * than a coloured one (D-M3 of the fourth review; `seed`). The panel's chart is then handed that map as its view's map
 * before it draws, and from there on follows its own rules: a series on screen never changes
 * colour, a viewer's "Colour the eight largest" changes that panel's copy only.
 *
 * How the map is handed over: the chart reads a view's map from the tab's session storage the
 * first time it draws the view (`vz-series8:<view>`, in the shape its own `vzChartRules.newMap()`
 * makes). The app writes it there before that first draw. That is the chart's storage, not an
 * input it documents: the need for an input of its own is in README, "Needed from the chart".
 */
import { chartLabels } from '../charts/spec'
import type { AlignedData } from '../lib/series'

const SLOTS = 8
const STORE = 'viz.dashboard.colours:'
const CHART_STORE = 'vz-series8:'

/** The chart's key for a label set (viz-chart.js `key`): names sorted, `name=value` joined by commas. */
export const chartKey = (labels: Record<string, string>) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',')

/** A series' identity on the dashboard, and the group it competes for slots in. */
export function identityOf(labels: Record<string, string>): { group: string; id: string } {
  const own = Object.fromEntries(Object.entries(labels).filter(([k]) => k !== '__name__'))
  return { group: Object.keys(own).sort().join(','), id: chartKey(own) }
}

interface Group {
  /** owner[slot] for slots 1 to 8 (index 0 unused), null while free. */
  owner: (string | null)[]
}
interface Stored {
  v: 1
  groups: Record<string, Group>
  /** The views whose chart map this dashboard has handed over in this tab. */
  seeded: string[]
}

function read(dashboard: string): Stored {
  try {
    const v = JSON.parse(sessionStorage.getItem(STORE + dashboard) ?? 'null') as Stored | null
    if (v && v.v === 1 && v.groups && Array.isArray(v.seeded)) return v
  } catch {
    // Nothing kept: start again.
  }
  return { v: 1, groups: {}, seeded: [] }
}

/** The dashboard's colours for the tab's session. One per dashboard page. */
export class DashboardColours {
  private readonly dashboard: string
  private state: Stored
  constructor(dashboard: string) {
    this.dashboard = dashboard
    this.state = read(dashboard)
  }

  /** The slot (1 to 8) an identity has on this dashboard, 0 for none yet. */
  slotOf(labels: Record<string, string>): number {
    const { group, id } = identityOf(labels)
    const g = this.state.groups[group]
    return g ? Math.max(0, g.owner.indexOf(id)) : 0
  }

  /**
   * Called before a panel's chart first draws `data` under `view`, with the query that names a
   * series without labels (as `toSpec` names it). Hands the panel's chart its starting map, by the
   * rule the lead set for D-M3 (review round 4; an amendment to D80): **the panel's eight largest
   * series, by the chart's own rank, are coloured; a series keeps the colour the dashboard's map
   * gives its identity when that colour is free in this panel, else takes the next free one; the
   * rest are Other, so nothing larger than a coloured series is in Other.** "The next free one" is
   * the lowest slot no series of this panel holds, preferring a slot the dashboard has given no
   * identity of the series' group, then one whose identity is not in this panel. A series coloured
   * here whose identity has no slot on the dashboard yet is given the slot it took, if no other
   * identity of its group has it. Does nothing for a view already handed over in this tab: its
   * chart keeps its own map from then on.
   */
  seed(view: string, data: AlignedData, query: string): void {
    if (this.state.seeded.includes(view)) return
    const series = data.series.map((s) => {
      const labels = chartLabels(s.labels, query)
      // The chart's rank (viz-chart.js `chartModel`): the highest value in the window; a series with no value in it ranks last.
      let max = -Infinity
      const v = s.values
      for (let i = 0; i < v.length; i++) if (v[i]! > max) max = v[i]! // NaN (a gap) compares false
      return { key: chartKey(labels), ...identityOf(labels), max }
    })
    // The chart's order (`byRank`): highest first, ties by key.
    const ranked = [...series].sort((a, b) => b.max - a.max || (a.key < b.key ? -1 : 1))
    const top = ranked.slice(0, SLOTS)
    const group = (g: string) => (this.state.groups[g] ??= { owner: new Array<string | null>(SLOTS + 1).fill(null) })
    const slot = new Map<string, number>()
    const taken = new Set<number>()
    // 1. The dashboard's colour for the identity, when no larger series of this panel has taken it.
    for (const s of top) {
      const d = group(s.group).owner.indexOf(s.id)
      if (d > 0 && !taken.has(d)) {
        slot.set(s.key, d)
        taken.add(d)
      }
    }
    // 2. The rest of the eight, largest first: the next free slot.
    const here = new Set(series.map((s) => `${s.group}\u0000${s.id}`))
    for (const s of top) {
      if (slot.has(s.key)) continue
      const owner = group(s.group).owner
      const free = [1, 2, 3, 4, 5, 6, 7, 8].filter((i) => !taken.has(i))
      const pick = free.find((i) => owner[i] === null) ?? free.find((i) => !here.has(`${s.group}\u0000${owner[i]}`)) ?? free[0]!
      slot.set(s.key, pick)
      taken.add(pick)
      if (!owner.includes(s.id) && owner[pick] === null) owner[pick] = s.id
    }
    const map = (window.vzChartRules as unknown as { newMap(): unknown }).newMap() as { owner: (string | null)[]; s: Record<string, { slot: number; held: number; was: string }> }
    for (const [key, i] of slot) {
      map.owner[i] = key
      map.s[key] = { slot: i, held: 0, was: 'away' }
    }
    this.state.seeded.push(view)
    try {
      sessionStorage.setItem(CHART_STORE + view, JSON.stringify(map))
      sessionStorage.setItem(STORE + this.dashboard, JSON.stringify(this.state))
    } catch {
      // Not kept: the chart starts the view's map from nothing, as before.
    }
  }
}
