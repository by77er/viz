A time-series chart: the product's core. `vz-chart` inside a `vz-panel-body`: an SVG plot (`vz-plot`) drawn by script at the pixel size of its region, a foot (`vz-chart-foot`) with the readout and zoom, and the legend as a table of series (`vz-legend-table`). The preview is a working reference implementation in plain script and SVG; its functions `assignSeries`, `distinguish`, `fit` and `valueTicks` are the rules below as code.

Every colour, stroke width and type size comes from the classes in `components.css`. A chart implementation sets geometry only. Canvas implementations read the same tokens.

## Series colour

1. **Slots.** `series-1` to `series-8`, in that order. All eight reach 3:1 on `ground`, `raised` and `sunken` in both themes and pass the colour-vision validator as an ordered set, so adjacent slots stay distinguishable. The order is never shuffled.
2. **A view owns a map from series to slot.** A series is identified by its full label set. The map lives as long as the view: an Explore tab keeps it for the tab's session (it survives reloads; it is discarded when the tab closes); a dashboard panel stores it with the panel, so every viewer and every reload sees the same colours; a shared link carries it (the ordered list of up to eight series keys), so the recipient sees the sender's colours.
3. **Survivors are never repainted.** Changing a filter, the range, the sort order or the query keeps every series that is still present on the slot it had.
4. **New series take the lowest free slots in order of rank.** Rank is the series' highest value in the window when it first appears, largest first; ties by name. So on first load the largest series is `series-1`, and the eight largest are the coloured ones: by size, never by name or by the order the server returned them.
5. **Released slots.** A series that leaves the view keeps its slot reserved, so it returns in the same colour, until a new series needs a slot and none is unreserved; then the slot of an absent series is reused.
6. **Everything else is Other**: one entry, drawn as one band from the lowest to the highest folded series at each step (fill `sunken`, edges `series-other`), under the coloured lines, with one legend row: "Other, 28 series, lowest to highest", whose figures are ranges. Never a line per folded series, never a legend row per folded series, and never a sum unless the chart is a stack (where Other is the sum, drawn as the last band). The row expands, 20 at a time, to list the folded series; choosing one draws it as a single line in `ink` (it has no colour to keep). A series is promoted from Other to a colour only when a slot is free under rule 4 or 5.
7. **Colour is never the only channel.** The second channel is position plus words: direct labels where they fit, otherwise the legend, which opens sorted by rank and can be sorted by the last value so its order matches the lines at the right edge; choosing rows draws only those series. Dashes are reserved for thresholds and are not used to tell series apart. Series colours never appear outside a chart and its legend; action and status colours never appear as series. A series that *means* a state (errors, failures) is still a series colour: state is said by the threshold and the status mark, not by drawing a line red.

## Direct labels

- Drawn in a gutter at the right of the plot (`label-gutter` wide), each at the height of its own line's last value, joined to that line end by a leader tick in `ink-muted`. Text is `small` in `ink-secondary`, never the series colour: the most distinguishing label value, fitted by the rule under "Legend".
- **Collisions.** Labels are sorted by height and pushed apart to one label height (16px) between centres, inside the plot's height. If any label would end more than two label heights from its own line end, or the plot is not tall enough for all of them, **no direct labels are drawn at all** and the legend carries the names. A label on the wrong line is worse than none.
- Only series whose line reaches the right edge are labelled; if one does not, none are. At most eight (the coloured series); the Other band is not labelled.
- **Below 640px of chart width, and in `data-size="sm"` charts, there are no direct labels**: legend only, and the plot takes the full width.

## Axes and time

- **Value axis.** Starts at zero unless the panel says otherwise in its meta. Three to five ticks (one per 40px of plot height at most) at round values (1, 2, 2.5 or 5 times a power of ten); when the chart has a threshold, the step is chosen so a tick lands on it. Ticks are bare numbers on one scale ("0, 250, 500, 750, 1,000"; never "1.0k" beside "667"). **The unit is written once**, at the top of the axis, in `ink-secondary`.
- **Time axis.** The plot's left and right edges are exactly the range's start and end, and both are always labelled with their own time, so the axis never stops short of "now". Between them, ticks at round clock times at least 64px apart; a round tick that would crowd an end label is dropped. 24-hour times; ranges over a day label midnights with the day ("Sat 14").
- **Step and aggregate** are stated in the panel meta, after the range: "09:16 to 15:16 · 6 min max". If the result was rolled up or sampled, that is where it says so.
- **Gaps are drawn as gaps.** A missing sample breaks the line; nothing is interpolated across it. A sample with a gap on both sides is a dot.
- Gridlines `rule`, the zero line `rule-control`, axis text `micro` in `ink-muted`.

## Thresholds, intervals and markers

- **Threshold**: a dashed `hairline` in `ink-secondary` across the plot, labelled at its left end with its value and what it is: "500 ms objective", "1% threshold". A dash with no words is not a threshold.
- **Interval** (firing, would have fired, silenced): a `sunken` span the full height of the plot with `rule-control` edges, behind the lines, labelled at its top with what it is and since when or for how long ("Firing since 13:07", "14 min"). An interval shorter than one `stroke` of width is drawn one `stroke` wide, so a 14-minute firing in a 7-day backtest is still visible; the meta says the step.
- **Marker** (deploy, config change, "above threshold since"): a vertical `hairline` in `ink-muted` with its word above the plot. Words that would overlap are dropped, later ones first; the lines stay, and every marker is in the timeline or the text form.
- Words on the plot have a `ground` halo so a line crossing them does not make them unreadable.

## Readout, crosshair, zoom

- **Crosshair**: a vertical `hairline` in `ink`, snapped to a sample, with a dot on each drawn series. It moves without laying anything out again.
- **The readout never covers the plot.** The time under the crosshair is written in the foot under the plot (its height is always reserved), and each series' value replaces the legend's "Last" column, whose head becomes "At 13:02". There is no floating tooltip.
- **Pointer**: move to read; drag across the plot to select a range (a `sunken` span with `ink` edges), release to zoom to it.
- **Touch**: drag horizontally to move the crosshair (the plot allows vertical page scroll only). Zoom is the two buttons in the foot, **"Zoom in"** (half the range, centred on the crosshair) and **"Zoom out"** (twice the range); nothing a pointer can do is missing from touch. A legend tap toggles a series; there is no modifier key anywhere.
- **Keyboard**: the plot is one tab stop. Left and Right move the crosshair one sample (ten with Shift), Home and End go to the ends, Escape clears it, plus and minus zoom. The foot is a polite live region that announces the time and the highest series; the accessible name says how many series there are and how they are drawn.

## Legend

- A table of series: swatch and name, then Last, Min, Max, with the unit once in the head ("Last, ms"). Min and Max are priority 2 and are dropped below 640px of table width; Name and Last stay.
- Heads are sortable (`vz-sort`). It opens in rank order. Sorting never repaints.
- **Each row is a toggle.** Choosing rows draws only the chosen series; choosing none draws all. Chosen rows are `ink` strong on `rule` (`aria-selected`), the rest are `ink-muted` with a hollow swatch (`data-off`). A press shows at once (`:active`).
- The legend is one tab stop; Up and Down move between rows; Space or Enter toggles.
- **Names: distinguishing labels first.** (1) Drop every label that has the same value on all series, and state those once under the table ("All series: namespace=\"prod\""). (2) Order the remaining labels by how many distinct values they take, most first; ties by name. The head names them in that order: "Series (pod · node · service)". (3) Show the values in that order, separated by " · ". (4) Every row shows the same labels: if any row's name is too wide, the last label is dropped from all rows (and from the head), until all fit or one label is left; a single value that is still too wide is cut **in the middle**, keeping its start and its end. The full label set is the row's title and its accessible name.
- The swatch has its own `ground` edge, so a hovered or chosen row does not lower its contrast.
- A single-series chart keeps the legend row: it carries the figures.

## Text and size

- Chart text is `micro` (axes, words on the plot) and `small` (direct labels, legend, foot), drawn at device pixels. The chart is drawn at the size of its region and redrawn when that changes; it is never scaled like an image, at any width or zoom.
- Plot height is `plot` in a dashboard panel, `plot-sm` beside a form or a claim.

## States

Loading and stale: see Panel. Empty: `vz-empty` in the plot's place, at its height. Error: `vz-empty` with the critical mark. Partial: the meta says what is missing. Crosshair, range selection, chosen rows, sorted head, expanded Other, focus on the plot and on a row are all in the preview.
