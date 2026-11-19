A labelled input. Wrap a `vz-label`, the control and an optional `vz-help` in `vz-field`. Controls: `vz-input` for text, `textarea.vz-input` for text that runs to several lines (a message, a description; three lines tall, grows by hand), `vz-select` for a choice among more than six fixed options, `vz-check` for a setting that is on or off, and `vz-range` for a time range.

- Add `data-mono` when the value is a query, duration, identifier, number or time.
- Mark an invalid value with `aria-invalid="true"` and point `aria-describedby` at a help line with `data-error`. The help line starts with the critical mark and says how to fix the value, in `ink`. A help line is one run of text: a `vz-qty` or a link inside it keeps its spaces.
- The label is always visible. Placeholders show an example, never the label, and never the exact value to type.
- A checkbox label says what is true when it is checked. Checked is an `ink` box with a tick, not blue: a setting is a state, not an action.
- **Time range** (`vz-range` inside a `fieldset.vz-field` with a `legend`): two `data-mono` text inputs, From and To, that take the system's own forms ("18 Nov 09:16", "09:16" for today, "now", "now - 6 h") and echo what they parsed in the help line; 24-hour clock, the zone stated once. Never the browser's date picker, whose form changes with the locale ("11/18/2026, 09:30:00 AM"). Below 640px the two fields stack. Presets (1 h, 6 h, 24 h, 7 d) are a `vz-segmented` beside it.
- With a coarse pointer, text inputs and selects, including `data-mono` ones, become `control-touch` tall with `body`-size text; smaller text makes mobile browsers zoom the page on focus. Checkboxes become `control-touch` tall.
- Stack fields with `vz-stack`; put the form's buttons in a `vz-controls` row.
- A `vz-select` with one option is not a control: write the value as text until there is a choice.
