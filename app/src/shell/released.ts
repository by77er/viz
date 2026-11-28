/**
 * The views this version offers a person: the shell's navigation, the command palette's "Go to"
 * commands and Help's sections list these and no others (README, "Released in this version").
 *
 * Dashboards and monitors are built, tested and served, and stay reachable at their own
 * addresses (/dashboards, /monitors; serve.json and the gateway are unchanged), but they are
 * unlisted until the fixes for their design re-review pass
 * (design-system/reviews/app-v9/rereview.md, parts 2 and 3). The pull request that releases them
 * adds them to this list, and nothing else needs to change to list them.
 */
export type View = 'explore' | 'dashboards' | 'monitors' | 'help' | 'settings'

export const RELEASED_VIEWS: readonly View[] = ['explore', 'help', 'settings']

export const isReleased = (view: View): boolean => RELEASED_VIEWS.includes(view)
