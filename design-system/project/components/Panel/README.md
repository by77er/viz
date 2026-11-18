A titled region holding one chart or one table. `vz-panel`: a head, an optional description, and a `vz-panel-body` with the content. Charts are specified in Chart.

- A `hairline` `ink` rule above the title is the only chrome. No box, fill or shadow.
- **The head describes the data on screen, never the request in flight.** Title, unit, range, step, legend, the chart's accessible name and the text form all come from the result that is drawn.
- **Meta** (`vz-panel-meta`, right of the title, `small` in `ink-muted`): the range, the step and aggregate, and the age: "09:16 to 15:16 · 6 min max · updated 12 s ago". Each part is its own `span`, so the line wraps between parts. The age follows the Number rules ("just now", "12 s ago", "14 min ago"). The age is required whenever the data is not live; for a fixed past range the range is stated too, because the age is then the age of the fetch.
- **While a new query is waiting** and the previous result is still drawn, the meta starts with `vz-panel-note`: **"Showing the previous query"**, in `ink`, and everything else in the head stays the previous query's. The same words stay after a cancel or a failure, until a result for the new query is drawn. An automatic refresh of the same query is not a new query and shows nothing.
- **Where the waiting line sits.** `vz-progress` is the first child of `vz-panel-body` and lies over the top edge of the body on `ground`. No space is reserved for it and nothing moves when it appears or goes; the result under it stays usable.
- After three failed refreshes the note reads "Not updating" with the reason.
- The description says what the reader should conclude from a change, in one or two sentences.
- Dashboards put panels in `vz-grid` inside `vz-dashboard`: twelve columns from 1200px of dashboard width, six from 640px, one below.
