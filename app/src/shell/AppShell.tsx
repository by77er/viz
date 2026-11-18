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

function ThemeIcon({ pref }: { pref: string }) {
  if (pref === 'dark')
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    )
  if (pref === 'light')
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    )
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" />
    </svg>
  )
}

export function AppShell() {
  const navigate = useNavigate()
  const { pref, cycle, setPref } = useTheme()
  const { settings } = useSettings()
  const { setPaletteOpen, paletteOpen } = useCommandsContext()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const info = useBackendInfo()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(!paletteOpen)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paletteOpen, setPaletteOpen])

  useCommands(
    'shell',
    [
      { id: 'nav-explore', group: 'Navigation', title: 'Go to Explore', keywords: 'metrics query promql', run: () => void navigate({ to: '/explore' }) },
      { id: 'nav-help', group: 'Navigation', title: 'Go to Keyboard shortcuts & help', keywords: 'about docs', run: () => void navigate({ to: '/help' }) },
      { id: 'settings-open', group: 'Settings', title: 'Open settings (API URL, token)', keywords: 'connection backend bearer', run: () => setSettingsOpen(true) },
      { id: 'theme-light', group: 'Settings', title: 'Theme: light', run: () => setPref('light') },
      { id: 'theme-dark', group: 'Settings', title: 'Theme: dark', run: () => setPref('dark') },
      { id: 'theme-system', group: 'Settings', title: 'Theme: follow system', run: () => setPref('system') },
    ],
    'static',
  )

  const unreachable = info.error instanceof PromApiError && info.error.errorType === 'network'
  const unauthorized = info.error instanceof PromApiError && (info.error.status === 401 || info.error.status === 403)

  const navClass =
    'flex h-full items-center border-b-2 border-transparent px-2.5 text-fg-2 hover:text-fg data-[status=active]:border-accent data-[status=active]:text-fg data-[status=active]:font-semibold'

  return (
    <div className="flex min-h-full flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-1.5">
        Skip to content
      </a>
      <header className="sticky top-0 z-20 flex h-10 shrink-0 items-center gap-1 border-b border-line bg-surface px-3">
        <Link to="/explore" className="mr-2 flex items-center gap-1.5 text-[14px] font-semibold tracking-tight" aria-label="viz home">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M1.5 12 5 5l3 4 3-6 3.5 9" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          </svg>
          viz
        </Link>
        <nav aria-label="Primary" className="flex h-full items-stretch">
          <Link to="/explore" className={navClass}>
            Explore
          </Link>
          <Link to="/help" className={navClass}>
            Help
          </Link>
        </nav>
        <div className="flex-1" />
        <button
          className="btn btn-ghost hidden gap-2 text-fg-3 sm:inline-flex"
          onClick={() => setPaletteOpen(true)}
          aria-label="Open command palette"
          aria-keyshortcuts="Control+K Meta+K"
        >
          <span>Commands</span>
          <span className="kbd">{MOD}</span>
          <span className="kbd -ml-1">K</span>
        </button>
        <button className="btn btn-ghost btn-icon sm:hidden" onClick={() => setPaletteOpen(true)} aria-label="Open command palette">
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
        <button className="btn btn-ghost btn-icon" onClick={cycle} aria-label={`Theme: ${pref}. Switch theme`} title={`Theme: ${pref}`}>
          <ThemeIcon pref={pref} />
        </button>
        <button className="btn btn-ghost btn-icon" onClick={() => setSettingsOpen(true)} aria-label="Settings" title="Settings">
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <circle cx="10.5" cy="4.5" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="5.5" cy="11.5" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      </header>

      {info.data?.mock && (
        <div role="status" data-testid="mock-banner" className="flex flex-wrap items-center gap-x-2 border-b border-warn-line bg-warn-soft px-3 py-1 text-[12px] text-warn-fg">
          <span className="rounded-sm border border-warn-line px-1 text-[10.5px] font-bold tracking-wider">MOCK</span>
          <span>
            Connected to the development mock backend ({info.data.version}): synthetic data and a subset of PromQL. Not a real viz deployment.
          </span>
        </div>
      )}
      {(unreachable || unauthorized) && (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 border-b border-danger-line bg-danger-soft px-3 py-1 text-[12px] text-danger">
          <span>
            {unreachable
              ? `Cannot reach the API at ${settings.baseUrl || window.location.origin}.`
              : 'The API rejected the credentials.'}
          </span>
          <button className="underline" onClick={() => setSettingsOpen(true)}>
            Open settings
          </button>
        </div>
      )}

      <main id="main" className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>

      <CommandPalette />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
