A labelled text input. Wrap a `vz-label`, a `vz-input` and an optional `vz-help` in `vz-field`.

- Add `data-mono` when the value is a query, duration, identifier or number.
- Mark an invalid value with `aria-invalid="true"` and a help line with `data-error` that says how to fix it. The help line stays `ink`; the border turns `red`.
- The label is always visible. Placeholders show an example, never the label.
