import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router'
import { AppShell } from './shell/AppShell'
import { HelpPage } from './shell/HelpPage'
import { ExplorePage } from './explore/ExplorePage'
import { parseExploreSearch, parseSearchString, stringifySearch, type ExploreSearch } from './lib/urlState'

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
  validateSearch: (raw: Record<string, unknown>): ExploreSearch => parseExploreSearch(raw),
  component: ExplorePage,
})

const helpRoute = createRoute({ getParentRoute: () => rootRoute, path: '/help', component: HelpPage })

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, exploreRoute, helpRoute]),
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
