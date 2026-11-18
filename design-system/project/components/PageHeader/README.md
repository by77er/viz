The top of a page: what it is, what state it is in, and what can be done. `vz-page-head` inside `vz-page`: a first child holding `vz-page-title` (an `h1` in `title`), an optional `vz-page-state` and a `vz-page-sub`, then a `vz-controls` row of actions.

- **Title**: the name of the thing, never a verb. One per page.
- **State line** (`vz-page-state`): for a page about something that has a state (a monitor, an investigation). `heading` type in `ink`, starting with the status mark. It is the strongest text after the title, because it is the answer the person came for. It states one time, defined once: "Firing since 13:07 (2 h 9 min)".
- **Sub-line** (`vz-page-sub`): `ink-secondary`, at most two sentences: counts, who was told, how fresh the page is. Every page states how fresh its data is, here or in its panels.
- **Actions**: a `vz-controls` row. At most one blue button. Two toned buttons side by side are `space-6` apart (the row does this by itself).
- **Wrap rule**: the actions sit at the right of the title, aligned to its last line, while the title block keeps `overlay-min` of width. When it cannot, the whole action row drops below the title block and aligns left; it never squeezes the title into a column of single words. Wrapped rows of actions are `space-3` apart (more with a coarse pointer), so hit areas cannot overlap.
- `vz-page` supplies the gutter (`space-6`, `space-4` below 640px) and `space-6` between regions. `vz-section-title` is the `h2`. `vz-split` is the two-column page (main and side, 2:1), one column below 800px of page width.
