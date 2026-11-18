A labelled input. Wrap a `vz-label`, the control and an optional `vz-help` in `vz-field`. Controls: `vz-input` for text, `vz-select` for a choice among more than six fixed options, `vz-check` for a setting that is on or off.

- Add `data-mono` when the value is a query, duration, identifier or number.
- Mark an invalid value with `aria-invalid="true"` and point `aria-describedby` at a help line with `data-error`. The help line starts with the critical mark and says how to fix the value, in `ink`.
- The label is always visible. Placeholders show an example, never the label.
- A checkbox label says what is true when it is checked. Checked is an `ink` box with a tick, not blue: a setting is a state, not an action.
- With a coarse pointer, text inputs and selects, including `data-mono` ones, become `control-touch` tall with `body`-size text; smaller text makes mobile browsers zoom the page on focus. Checkboxes become `control-touch` tall.
- Stack fields with `vz-stack`; put the form's buttons in a `vz-controls` row.
- A `vz-select` with one option is not a control: write the value as text until there is a choice.
