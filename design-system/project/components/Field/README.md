A labelled input. Wrap a `vz-label`, the control and an optional `vz-help` in `vz-field`. Controls: `vz-input` for text, `vz-select` for a choice among more than six fixed options, `vz-check` for a setting that is on or off.

- Add `data-mono` when the value is a query, duration, identifier or number.
- Mark an invalid value with `aria-invalid="true"` and point `aria-describedby` at a help line with `data-error`. The help line starts with the critical mark and says how to fix the value, in `ink`.
- The label is always visible. Placeholders show an example, never the label.
- A checkbox label says what is true when it is checked. Checked is `ink`, not blue: a setting is a state, not an action.
- With a coarse pointer, text inputs and selects become `control-touch` tall with `body`-size text; smaller text makes mobile browsers zoom the page on focus.
