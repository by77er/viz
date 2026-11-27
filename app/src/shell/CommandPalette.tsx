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
    listRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' })
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
      className="palette"
      onClose={() => setPaletteOpen(false)}
      onClick={(e) => {
        if (e.target === dialogRef.current) setPaletteOpen(false)
      }}
    >
      {/* The design system's menu with a field above it. Groups are divided by separators, not headings. */}
      <div className="vz-menu">
        <label className="vz-field">
          <span className="vz-label">Command</span>
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
          aria-haspopup="menu"
          aria-expanded="true"
          aria-controls="cmdk-list"
          aria-activedescendant={ordered[activeIndex] ? `cmd-${ordered[activeIndex].id}` : undefined}
          className="vz-input"
          autoComplete="off"
          spellCheck={false}
          data-testid="palette-input"
        />
        </label>
        {/* A list that scrolls is a tab stop of the browser's own making; the field moves through it with the arrow keys, so it is not one (design review m3). */}
        <div ref={listRef} id="cmdk-list" role="menu" aria-label="Commands" className="palette-list" tabIndex={-1}>
          {ordered.length === 0 && (
            <div className="palette-none" role="presentation">
              No command matches “{query}”.
            </div>
          )}
          {groups.map((g, gi) => (
            <div key={g.group} role="group" aria-label={g.group}>
              {gi > 0 && <div role="separator" />}
              {g.items.map(({ c }) => {
                const idx = ordered.indexOf(c)
                const selected = idx === activeIndex
                return (
                  <div
                    key={c.id}
                    id={`cmd-${c.id}`}
                    role="menuitem"
                    tabIndex={-1}
                    data-active={selected ? '' : undefined}
                    onPointerMove={() => setActive(idx)}
                    onClick={() => exec(c)}
                  >
                    <span>{c.title}</span>
                    {c.shortcut && <span className="vz-kbd">{c.shortcut}</span>}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </dialog>
  )
}
