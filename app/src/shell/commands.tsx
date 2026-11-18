import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

export interface Command {
  id: string
  title: string
  /** Group heading in the palette. */
  group: 'Navigation' | 'Query' | 'Time range' | 'View' | 'Settings'
  /** Display-only shortcut hint, e.g. "Ctrl+Enter". */
  shortcut?: string
  keywords?: string
  run: () => void
}

interface CommandsContextValue {
  commands: Command[]
  register: (owner: string, commands: Command[]) => void
  unregister: (owner: string) => void
  paletteOpen: boolean
  setPaletteOpen: (open: boolean | ((prev: boolean) => boolean)) => void
}

const CommandsContext = createContext<CommandsContextValue | null>(null)

export function CommandsProvider({ children }: { children: ReactNode }) {
  const [byOwner, setByOwner] = useState<Record<string, Command[]>>({})
  const [paletteOpen, setPaletteOpen] = useState(false)
  const register = useCallback((owner: string, commands: Command[]) => setByOwner((m) => ({ ...m, [owner]: commands })), [])
  const unregister = useCallback(
    (owner: string) =>
      setByOwner((m) => {
        const { [owner]: _, ...rest } = m
        return rest
      }),
    [],
  )
  const value = useMemo(
    () => ({ commands: Object.values(byOwner).flat(), register, unregister, paletteOpen, setPaletteOpen }),
    [byOwner, register, unregister, paletteOpen],
  )
  return <CommandsContext.Provider value={value}>{children}</CommandsContext.Provider>
}

export function useCommandsContext(): CommandsContextValue {
  const v = useContext(CommandsContext)
  if (!v) throw new Error('useCommandsContext outside CommandsProvider')
  return v
}

/**
 * Register commands for as long as the calling component is mounted. The command list is
 * registered once per `key` change; `run` always calls the latest closure.
 */
export function useCommands(owner: string, commands: Command[], key: string): void {
  const { register, unregister } = useCommandsContext()
  const latest = useRef(commands)
  latest.current = commands
  useEffect(() => {
    register(
      owner,
      latest.current.map((c, i) => ({ ...c, run: () => latest.current[i]?.run() })),
    )
    return () => unregister(owner)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, key, register, unregister])
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
export const MOD = isMac ? '⌘' : 'Ctrl'

/** Rank commands against a query: all words must match title/group/keywords. */
export function filterCommands(commands: Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return commands
  const scored: { c: Command; score: number }[] = []
  for (const c of commands) {
    const title = c.title.toLowerCase()
    const hay = `${title} ${c.group.toLowerCase()} ${c.keywords?.toLowerCase() ?? ''}`
    if (!words.every((w) => hay.includes(w))) continue
    let score = 0
    for (const w of words) score += title.startsWith(w) ? 3 : title.includes(w) ? 2 : 1
    scored.push({ c, score })
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.c)
}
