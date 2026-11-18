import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { PromClient } from '../api/client'

/**
 * Connection settings live in localStorage only. The token is never written to the URL,
 * to query keys, or to anything else that could be shared or logged.
 */
export interface Settings {
  baseUrl: string
  token: string
}

const KEY = 'viz.settings'
export const DEFAULT_SETTINGS: Settings = {
  baseUrl: (import.meta.env?.VITE_API_BASE_URL as string | undefined) ?? '',
  token: '',
}

export function loadSettings(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): Settings {
  try {
    const raw = storage?.getItem(KEY)
    if (!raw) return DEFAULT_SETTINGS
    const v = JSON.parse(raw) as Partial<Settings>
    return {
      baseUrl: typeof v.baseUrl === 'string' ? v.baseUrl : DEFAULT_SETTINGS.baseUrl,
      token: typeof v.token === 'string' ? v.token : '',
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(s: Settings, storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(s))
  } catch {
    // Private mode or quota: the settings still apply for this session.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

interface SettingsContextValue {
  settings: Settings
  setSettings: (s: Settings) => void
  client: PromClient
  /** Changes whenever the connection changes; safe to put in query keys (not the token). */
  connectionId: string
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, set] = useState<Settings>(() => loadSettings())
  const [version, setVersion] = useState(0)
  const value = useMemo<SettingsContextValue>(
    () => ({
      settings,
      setSettings: (s) => {
        saveSettings(s)
        set(s)
        setVersion((v) => v + 1)
      },
      client: new PromClient({ baseUrl: settings.baseUrl, token: settings.token }),
      connectionId: `${settings.baseUrl}#${version}`,
    }),
    [settings, version],
  )
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings(): SettingsContextValue {
  const v = useContext(SettingsContext)
  if (!v) throw new Error('useSettings outside SettingsProvider')
  return v
}
