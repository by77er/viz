import { useEffect, type ReactNode } from 'react'
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { PromApiError } from '../api/client'
import { useWaiting } from '../explore/waiting'
import { installFocusKeeper } from '../lib/focusKeeper'
import { CommandPalette } from './CommandPalette'
import { ErrorBoundary } from './ErrorBoundary'
import { useCommands, useCommandsControl } from './commands'
import { useSession } from './session'
import { SignIn } from './SignIn'
import { useTheme } from './theme'

/** Build info doubles as the connection check and the "is this the mock?" probe. Asked only once signed in: it needs the key. */
export function useBackendInfo() {
  const { client, connectionId, session } = useSession()
  return useQuery({
    queryKey: ['buildinfo', connectionId],
    queryFn: ({ signal }) => client.buildInfo({ signal }),
    enabled: session.status === 'in',
    retry: false,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    // While the API cannot be reached the page asks again by itself, and the banner goes when it answers (README, "Offline or stalled").
    refetchInterval: (q) => (q.state.error instanceof PromApiError && q.state.error.errorType === 'network' ? 10_000 : false),
  })
}

/** The development mock says what it is: the page shows data that is not a deployment's. */
function MockBanner() {
  return (
    <div role="status" data-testid="mock-banner" className="vz-banner">
      <span className="vz-mark" data-state="warn" />
      <p>This is the development mock: synthetic data and a subset of PromQL. It is not a viz deployment.</p>
    </div>
  )
}

/** A page that shows a tenant's data: the sign-in form until the API has said who the key is. */
export function RequireKey({ children }: { children: ReactNode }) {
  const { session } = useSession()
  const wait = useWaiting(session.status === 'checking')
  if (session.status === 'in') return <>{children}</>
  if (session.status === 'out') return <SignIn reason={session.reason} detail={session.detail} />
  // Asking who the key is. Nothing under 400 ms, not even an empty page (a box here would be
  // moved by a banner that arrives with the answer); then what is being waited for, and for how long.
  if (!wait.shown) return null
  return (
    <div className="vz-page" aria-busy="true" data-testid="checking">
      <div className="vz-progress" data-unmeasured="">
        <div className="vz-progress-text">
          <span role="status">Asking the API who this tab's key is.</span>
          <span className="vz-qty" aria-hidden="true">
            {(wait.elapsedMs / 1000).toFixed(1)} s
          </span>
        </div>
      </div>
    </div>
  )
}

export function AppShell() {
  const navigate = useNavigate()
  // The page the outlet is showing (the match it renders, which follows the address a moment later): a page that stopped is left behind with it.
  const page = useRouterState({ select: (s) => s.matches[s.matches.length - 1]?.id ?? '' })
  const { setPref } = useTheme()
  const { session, signOut } = useSession()
  const { setPaletteOpen } = useCommandsControl()
  const info = useBackendInfo()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        // Functional update: the listener must not depend on a possibly stale closure.
        setPaletteOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPaletteOpen])

  // A control that goes away while it has focus hands the focus on; it never falls to the document.
  useEffect(() => installFocusKeeper(), [])

  const signedIn = session.status === 'in'
  useCommands(
    'shell',
    [
      { id: 'nav-explore', group: 'Navigation', title: 'Go to Explore', keywords: 'metrics query promql', run: () => void navigate({ to: '/explore' }) },
      { id: 'nav-dashboards', group: 'Navigation', title: 'Go to Dashboards', keywords: 'boards panels overview list', run: () => void navigate({ to: '/dashboards' }) },
      { id: 'nav-monitors', group: 'Navigation', title: 'Go to Monitors', keywords: 'alerts alerting firing on call acknowledge silence', run: () => void navigate({ to: '/monitors' }) },
      { id: 'nav-help', group: 'Navigation', title: 'Go to Help', keywords: 'keyboard shortcuts about docs', run: () => void navigate({ to: '/help' }) },
      { id: 'nav-settings', group: 'Navigation', title: 'Go to Settings', keywords: 'api key tenant theme sign out', run: () => void navigate({ to: '/settings' }) },
      { id: 'theme-light', group: 'Settings', title: 'Use the light theme', run: () => setPref('light') },
      { id: 'theme-dark', group: 'Settings', title: 'Use the dark theme', run: () => setPref('dark') },
      { id: 'theme-system', group: 'Settings', title: 'Follow the system theme', run: () => setPref('system') },
      ...(signedIn && session.unchecked !== 'no-control' ? [{ id: 'sign-out', group: 'Settings' as const, title: 'Sign out', keywords: 'api key forget', run: () => signOut('left') }] : []),
    ],
    signedIn ? 'in' : 'out',
  )

  const unreachable = info.error instanceof PromApiError && info.error.errorType === 'network'

  // Known with the identity, which a page that shows data has before its first frame (so the
  // banner is there from the start and nothing moves); the build information says it too.
  const mock = signedIn && (session.identity?.mock === true || info.data?.mock === true)
  const tenant = signedIn ? session.identity?.tenant : undefined

  return (
    <>
      <a href="#main" className="vz-button vz-skip">
        Skip to content
      </a>
      <nav className="vz-nav" aria-label="Sections">
        <span className="vz-nav-name">viz</span>
        <Link to="/explore">Explore</Link>
        <Link to="/dashboards">Dashboards</Link>
        <Link to="/monitors">Monitors</Link>
        <Link to="/help">Help</Link>
        {/* The tenant is the key's, never a choice: text, not a link. */}
        {tenant && (
          <span className="vz-nav-end vz-secondary" data-testid="tenant" title={`Signed in to the tenant ${tenant}`}>
            {tenant}
          </span>
        )}
        <Link to="/settings" className={tenant ? undefined : 'vz-nav-end'}>
          Settings
        </Link>
      </nav>

      {(mock || unreachable) && (
        <div className="vz-page app-notices">
          {mock && <MockBanner />}
          {unreachable && (
            <div role="alert" className="vz-banner" data-testid="offline-banner">
              <span className="vz-mark" data-state="critical" />
              <p>
                The API at <span className="vz-qty">{window.location.host}</span> does not answer. What is on screen stays; the page asks again every{' '}
                <span className="vz-qty">10 s</span>.
              </p>
            </div>
          )}
        </div>
      )}

      <main id="main">
        {/* Something that throws in a page (the chart's script on a result it cannot draw) shows what happened, not an empty document. */}
        <ErrorBoundary resetKey={page}>
          <Outlet />
        </ErrorBoundary>
      </main>

      <CommandPalette />
    </>
  )
}
