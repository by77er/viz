import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router'
import { AppShell, RequireKey } from './shell/AppShell'
import { HelpPage } from './shell/HelpPage'
import { SettingsPage } from './shell/SettingsPage'
import { ExplorePage } from './explore/ExplorePage'
import { parseExploreSearch, parseSearchString, stringifySearch, withoutDefaults, type ExploreSearch } from './lib/urlState'

const rootRoute = createRootRoute({ component: AppShell })

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/explore' })
  },
})

export const exploreRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/explore',
  // Validated, with defaults dropped, so links elsewhere need not spell out every field.
  validateSearch: (raw: Record<string, unknown>): Partial<ExploreSearch> => withoutDefaults(parseExploreSearch(raw)),
  // Explore shows a tenant's data: the sign-in form stands in its place, at its address, until a key is accepted.
  component: () => (
    <RequireKey>
      <ExplorePage />
    </RequireKey>
  ),
})

const helpRoute = createRoute({ getParentRoute: () => rootRoute, path: '/help', component: HelpPage })
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage })

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, exploreRoute, helpRoute, settingsRoute]),
  // Flat, human-readable search params (no JSON quoting); defaults are omitted.
  parseSearch: parseSearchString,
  stringifySearch,
  defaultPreload: false,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
