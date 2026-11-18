import { useEffect, useMemo, useRef, useState } from 'react'
import { filterCommands, useCommandsContext, type Command } from './commands'

export function CommandPalette() {
  const { commands, paletteOpen, setPaletteOpen } = useCommandsContext()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  useEffect(() => {
    const d = dialogRef.current
    if (!d) return
    if (paletteOpen && !d.open) {
      setQuery('')
      setActive(0)
      d.showModal()
      inputRef.current?.focus()
    } else if (!paletteOpen && d.open) {
      d.close()
    }
  }, [paletteOpen])

  const results = useMemo(() => filterCommands(commands, query), [commands, query])
  const activeIndex = Math.min(active, Math.max(0, results.length - 1))

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, results])

  const exec = (c: Command | undefined) => {
    if (!c) return
    setPaletteOpen(false)
    setQuery('')
    setActive(0)
    // Let the dialog close (and focus return) before the command acts.
    setTimeout(() => c.run(), 0)
  }

  // Group while preserving the ranked order within each group.
  const groups = useMemo(() => {
    const out: { group: string; items: { c: Command; index: number }[] }[] = []
    results.forEach((c, index) => {
      let g = out.find((x) => x.group === c.group)
      if (!g) {
        g = { group: c.group, items: [] }
        out.push(g)
      }
      g.items.push({ c, index })
    })
    return out
  }, [results])
  // Keyboard order must follow the visual (grouped) order.
  const ordered = useMemo(() => groups.flatMap((g) => g.items.map((i) => i.c)), [groups])

  return (
    <dialog
      ref={dialogRef}
      aria-label="Command palette"
      className="fixed left-1/2 top-[12vh] m-0 w-[560px] -translate-x-1/2"
      onClose={() => setPaletteOpen(false)}
      onClick={(e) => {
        if (e.target === dialogRef.current) setPaletteOpen(false)
      }}
    >
      <div className="flex flex-col">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((activeIndex + 1) % Math.max(1, ordered.length))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((activeIndex - 1 + ordered.length) % Math.max(1, ordered.length))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              exec(ordered[activeIndex])
            }
          }}
          role="combobox"
          aria-expanded="true"
          aria-controls="cmdk-list"
          aria-activedescendant={ordered[activeIndex] ? `cmd-${ordered[activeIndex].id}` : undefined}
          aria-label="Search commands"
          placeholder="Type a command…"
          className="h-11 border-b border-line bg-transparent px-4 text-[14px] outline-none placeholder:text-fg-3"
          autoComplete="off"
          spellCheck={false}
        />
        <div ref={listRef} id="cmdk-list" role="listbox" aria-label="Commands" className="max-h-[52vh] overflow-y-auto p-1.5">
          {ordered.length === 0 && <div className="px-3 py-6 text-center text-fg-3">No matching command</div>}
          {groups.map((g) => (
            <div key={g.group} role="group" aria-label={g.group}>
              <div className="label px-2.5 pb-1 pt-2">{g.group}</div>
              {g.items.map(({ c }) => {
                const idx = ordered.indexOf(c)
                const selected = idx === activeIndex
                return (
                  <div
                    key={c.id}
                    id={`cmd-${c.id}`}
                    role="option"
                    aria-selected={selected}
                    onMouseMove={() => setActive(idx)}
                    onClick={() => exec(c)}
                    className={`flex h-8 cursor-pointer items-center justify-between rounded px-2.5 ${selected ? 'bg-accent-soft text-fg' : 'text-fg-2'}`}
                  >
                    <span>{c.title}</span>
                    {c.shortcut && <span className="text-[11px] text-fg-3">{c.shortcut}</span>}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
        <div className="flex gap-4 border-t border-line px-4 py-1.5 text-[11px] text-fg-3">
          <span>
            <span className="kbd">↑</span> <span className="kbd">↓</span> select
          </span>
          <span>
            <span className="kbd">Enter</span> run
          </span>
          <span>
            <span className="kbd">Esc</span> close
          </span>
        </div>
      </div>
    </dialog>
  )
}
