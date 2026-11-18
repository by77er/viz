A titled region holding one chart or one table. `vz-panel` with a head, an optional description, the content and a legend.

- A `hairline` `ink` rule above the title is the only chrome. No box, fill or shadow.
- The head carries the title and, at the right in `ink-muted`, the unit, the range and how old the data is ("updated 12 s ago"). The age is required whenever the data is not live.
- The description says what the reader should conclude from a change, in one or two sentences.
- Lines are `stroke` wide in `series-1` onward; gridlines `rule`; the baseline `rule-control`; axis text `micro` in `ink-muted`. Label up to four series directly and always include the legend.
- Draw charts at the size of their region, in device pixels. Never scale a chart like an image: its text must stay at `micro` and `small`. The preview is a fixed-size illustration inside `vz-chart`, which scrolls.
- Dashboards put panels in `vz-grid` inside `vz-dashboard`: twelve columns from 1200px of dashboard width, six from 640px, one below.
