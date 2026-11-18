import { useEffect, useState } from 'react'
import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { PromApiError } from '../api/client'
import { CommandPalette } from './CommandPalette'
import { MOD, useCommands, useCommandsContext } from './commands'
import { SettingsPanel } from './SettingsPanel'
import { useSettings } from './settings'
import { useTheme } from './theme'

/** Build info doubles as the connection check and the "is this the mock?" probe. */
export function useBackendInfo() {
  const { client, connectionId } = useSettings()
  return useQuery({
    queryKey: ['buildinfo', connectionId],
    queryFn: ({ signal }) => client.buildInfo({ signal }),
    retry: false,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })
}

const MOCK_KEY = 'viz.backend.mock'

/**
 * Whether the last backend this browser talked to was the mock. The mock banner is known
 * only after a request, so its space is reserved while that request is pending unless the
 * last answer was "not the mock"; otherwise everything below would move when it arrives.
 */
function lastKnownMock(): boolean {
  try {
    return localStorage.getItem(MOCK_KEY) !== '0'
  } catch {
    return true
  }
}

function MockSentence({ version }: { version: string }) {
  return (
    <p>
      Connected to the development mock backend (<span className="app-num">{version}</span>): synthetic data and a subset of PromQL. Not a
      real viz deployment.
    </p>
  )
}

export function AppShell() {
  const navigate = useNavigate()
  const { setPref } = useTheme()
  const { settings } = useSettings()
  const { setPaletteOpen } = useCommandsContext()
  const [settingsOpen, setSettingsOpen] = useState(false)
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

  useCommands(
    'shell',
    [
      { id: 'nav-explore', group: 'Navigation', title: 'Go to Explore', keywords: 'metrics query promql', run: () => void navigate({ to: '/explore' }) },
      { id: 'nav-help', group: 'Navigation', title: 'Go to keyboard shortcuts and help', keywords: 'about docs', run: () => void navigate({ to: '/help' }) },
      { id: 'settings-open', group: 'Settings', title: 'Open settings', keywords: 'connection backend bearer api url token theme', run: () => setSettingsOpen(true) },
      { id: 'theme-light', group: 'Settings', title: 'Use the light theme', run: () => setPref('light') },
      { id: 'theme-dark', group: 'Settings', title: 'Use the dark theme', run: () => setPref('dark') },
      { id: 'theme-system', group: 'Settings', title: 'Follow the system theme', run: () => setPref('system') },
    ],
    'static',
  )

  const unreachable = info.error instanceof PromApiError && info.error.errorType === 'network'
  const unauthorized = info.error instanceof PromApiError && (info.error.status === 401 || info.error.status === 403)

  const mock = info.data?.mock
  useEffect(() => {
    if (mock === undefined) return
    try {
      localStorage.setItem(MOCK_KEY, mock ? '1' : '0')
    } catch {
      // The reservation falls back to its default.
    }
  }, [mock])
  const reserveBanner = info.isPending && lastKnownMock()

  return (
    <div className="app">
      <a href="#main" className="vz-button app-skip">
        Skip to content
      </a>
      <header className="vz-nav app-nav">
        <span className="vz-nav-name">viz</span>
        <nav aria-label="Primary" className="app-links">
          <Link to="/explore">Explore</Link>
          <Link to="/help">Help</Link>
        </nav>
        <span className="grow" />
        <button className="vz-button" data-quiet="" onClick={() => setPaletteOpen(true)} aria-keyshortcuts="Control+K Meta+K" data-testid="open-commands">
          Commands
          <span className="vz-kbd wide-only">{MOD} K</span>
        </button>
        <button className="vz-button" data-quiet="" onClick={() => setSettingsOpen(true)} data-testid="open-settings">
          Settings
        </button>
      </header>

      <div className="app-notices">
        {mock && (
          <div role="status" data-testid="mock-banner" className="vz-banner">
            <span className="vz-mark" data-state="warn" />
            <MockSentence version={info.data!.version} />
          </div>
        )}
        {reserveBanner && (
          <div className="vz-banner is-reserved" aria-hidden="true">
            <span className="vz-mark" data-state="warn" />
            <MockSentence version="viz-mock-0.0.0" />
          </div>
        )}
        {(unreachable || unauthorized) && (
          <div role="alert" className="vz-banner">
            <span className="vz-mark" data-state="critical" />
            <p>
              {unreachable ? (
                <>
                  Cannot reach the API at <span className="app-num">{settings.baseUrl || window.location.origin}</span>. Check the address in
                  settings.
                </>
              ) : (
                'The API rejected the credentials. Enter a valid bearer token in settings.'
              )}
            </p>
            <button className="vz-button" data-size="sm" onClick={() => setSettingsOpen(true)}>
              Open settings
            </button>
          </div>
        )}
      </div>

      <main id="main" className="app-main">
        <Outlet />
      </main>

      <CommandPalette />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
