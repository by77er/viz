A list of commands or choices on a `raised` surface. `vz-menu` with `role="menuitem"` rows and `role="separator"` dividers. A row may be a `div` or a real `button`; the class resets a button's own border, fill and alignment.

- Each row is a verb phrase, with its shortcut as a `vz-kbd` in `ink-secondary` at the right. The active row is `hover`; a press is `pressed`, painted at once.
- **A row that holds a choice** (the current time range, a sort order, a setting that is on) is `role="menuitemradio"` or `menuitemcheckbox` with `aria-checked`. Every such row reserves a tick column at its left; the chosen row has the tick, in `ink`, and is `ui-strong`. Not blue, not inverted. Do not mix checkable and plain rows without a separator between them.
- Group with separators, not headings. The command palette is the same component with a labelled field above it.
- With a coarse pointer rows are `control-touch` tall.
