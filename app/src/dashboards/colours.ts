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
 * a panel is drawn in this tab, the dashboard's map gives each of its series the slot that
 * identity already has on the dashboard; a series the dashboard has not seen takes the group's
 * next free slot, largest first, while one of the eight is free; the rest are Other, as the
 * chart's own rules have them. The panel's chart is then handed that map as its view's map
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
   * series without labels (as `toSpec` names it). Gives the series the dashboard's slots, and the
   * ones it has not seen the next free slots of their group, largest first; then hands the
   * panel's chart that map. Does nothing for a view already handed over in this tab: its chart
   * keeps its own map from then on.
   */
  seed(view: string, data: AlignedData, query: string): void {
    if (this.state.seeded.includes(view)) return
    const series = data.series.map((s) => {
      const labels = chartLabels(s.labels, query)
      let max = -Infinity
      const v = s.values
      for (let i = 0; i < v.length; i++) if (v[i]! > max) max = v[i]! // NaN (a gap) compares false
      return { key: chartKey(labels), ...identityOf(labels), max }
    })
    // New identities take free slots of their group, largest first (the chart's rank: the highest value in the window).
    for (const s of [...series].sort((a, b) => b.max - a.max || (a.key < b.key ? -1 : 1))) {
      const g = (this.state.groups[s.group] ??= { owner: new Array<string | null>(SLOTS + 1).fill(null) })
      if (g.owner.includes(s.id)) continue
      const free = g.owner.indexOf(null, 1)
      if (free > 0) g.owner[free] = s.id
    }
    const map = (window.vzChartRules as unknown as { newMap(): unknown }).newMap() as { owner: (string | null)[]; s: Record<string, { slot: number; held: number; was: string }> }
    const taken = new Set<number>()
    for (const s of series) {
      const slot = this.state.groups[s.group]!.owner.indexOf(s.id)
      // Two series of one panel with one identity (never, unless a panel repeats a label set): the first keeps the slot.
      if (slot < 1 || taken.has(slot)) continue
      taken.add(slot)
      map.owner[slot] = s.key
      map.s[s.key] = { slot, held: 0, was: 'away' }
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
