/**
 * A reload lands where the page was scrolled to (design review B3; README, "Keep focus and
 * scroll position where they were").
 *
 * The browser's own restoration cannot do it here. It restores while the document loads, and
 * at the `load` event this page is still one window tall: the app draws after its script has
 * run and the API has said whose key the tab holds. And the router scrolls the window to the
 * top when its first page has rendered, as it does for every navigation that does not ask
 * otherwise. So the position is kept here: written to the tab's sessionStorage when the page
 * is hidden or left, and put back in the first frame in which the page is tall enough to hold
 * it, which is the frame the page's reserved layout is drawn in (a chart's height is reserved
 * before its data arrives). Until the person touches the page it is held there against the
 * router's reset and against the browser's own late attempt; their first input ends it.
 *
 * Only a reload, and a return to this document through the history, restore: a link opened
 * afresh starts at the top.
 */
const KEY = 'viz.scroll'
/** How long a reload may wait for the page to be tall enough: the waiting table's stop. */
const GIVE_UP_MS = 60_000
/** How long the position is held once it is reached: the router's reset comes with its first rendered page. */
const HOLD_MS = 1_000

interface Kept {
  path: string
  search: string
  y: number
}

function read(): Kept | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Partial<Kept> | null
    if (v && typeof v.path === 'string' && typeof v.search === 'string' && typeof v.y === 'number' && Number.isFinite(v.y)) return v as Kept
  } catch {
    // Nothing kept.
  }
  return null
}

/** Whether a kept position belongs to this load: the same page reloaded, or the same address come back to. */
export function restores(kept: Kept | null, navigation: string, path: string, search: string): kept is Kept {
  if (!kept || kept.y <= 0 || kept.path !== path) return false
  if (navigation === 'reload') return true
  return navigation === 'back_forward' && kept.search === search
}

export function installScrollKeeper(): void {
  const save = () => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ path: location.pathname, search: location.search, y: Math.round(window.scrollY) } satisfies Kept))
    } catch {
      // Not kept: the next load starts at the top.
    }
  }
  const kept = read()
  const navigation = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type ?? 'navigate'
  // Written when the page is hidden as well as when it is left: a phone discards a tab in the background without telling it.
  window.addEventListener('pagehide', save)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save()
  })
  if (!restores(kept, navigation, location.pathname, location.search)) return

  const y = kept.y
  let reachedAt = 0
  const root = document.documentElement
  const place = () => {
    if (root.scrollHeight - window.innerHeight < y) return
    if (Math.round(window.scrollY) !== y) window.scrollTo(0, y)
    if (reachedAt === 0) {
      reachedAt = performance.now()
      setTimeout(stop, HOLD_MS)
    }
  }
  // The page's height changes when the app draws: observed after layout and before the frame is painted, so the frame that is tall enough is shown in place.
  const sizes = new ResizeObserver(place)
  const inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
  const giveUp = setTimeout(stop, GIVE_UP_MS)
  function stop() {
    sizes.disconnect()
    window.removeEventListener('scroll', place)
    for (const type of inputs) window.removeEventListener(type, stop, true)
    clearTimeout(giveUp)
  }
  sizes.observe(root)
  sizes.observe(document.body)
  window.addEventListener('scroll', place, { passive: true })
  for (const type of inputs) window.addEventListener(type, stop, { capture: true, passive: true })
  place()
}
