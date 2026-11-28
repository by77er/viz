import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const KEY = 'viz.theme'

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

interface ThemeContextValue {
  pref: ThemePref
  resolved: ResolvedTheme
  setPref: (p: ThemePref) => void
  /** system -> light -> dark -> system */
  cycle: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readPref)
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    if (pref === 'system') delete root.dataset.theme
    else root.dataset.theme = pref
  }, [pref])

  const setPref = useCallback((p: ThemePref) => {
    setPrefState(p)
    try {
      if (p === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, p)
    } catch {
      // ignore
    }
  }, [])

  const value = useMemo<ThemeContextValue>(() => {
    const resolved: ResolvedTheme = pref === 'system' ? (systemDark ? 'dark' : 'light') : pref
    return {
      pref,
      resolved,
      setPref,
      cycle: () => setPref(pref === 'system' ? 'light' : pref === 'light' ? 'dark' : 'system'),
    }
  }, [pref, systemDark, setPref])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const v = useContext(ThemeContext)
  if (!v) throw new Error('useTheme outside ThemeProvider')
  return v
}
