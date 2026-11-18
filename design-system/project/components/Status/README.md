The state of one thing: a mark, then a word in `ink`. `vz-status` with `data-state` of `ok`, `warn`, `critical` or `info`; no state means unknown.

Each state has its own shape, so a column of them can be scanned without colour: critical is a solid square, warning a diamond, healthy a hollow square, informational a short bar, unknown a dash. Colours come from `status-critical`, `status-warn`, `status-ok` and `status-info`, which are lighter in the dark theme; they are not the button colours.

The word is required and is never coloured. Use the word that says what is wrong ("Burning budget"), not the level ("Critical"). `vz-mark` draws the mark alone, for banners and help lines.
