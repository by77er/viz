# Fixes to the review of the app restyle

The review (`../review.md`) rejected the restyle with three blockers and eight majors. The
work is split: the design system is being revised separately (`design-system/`), and a later
change applies it to the app's styling and charts. This change fixes the app's own **logic**
findings: B1, B3, M3, M5, M7, the mechanism of M2, the logic of M4, and the minors that are
wording or logic. It does not restyle, does not edit `design-system/`, and does not touch
`app/src/app.css`. What is left for the system migration is listed at the end.

All paths are under `app/`. Tests: `src/**/*.test.ts` (vitest), `e2e/fixes.cjs` (Playwright,
written for these fixes), `e2e/run.cjs` and `e2e/design.cjs` (the existing suites).

## B1 (blocker): old data shown under the new query's unit and name

**What changed.** A result now carries what describes it, and everything that describes the
data on screen is derived from the result, never from the editor or the URL.

- `src/lib/describe.ts`: `identify(request, window, receivedAt)` fixes, when the response
  arrives, the request it answers (query text, from, to, step), the window queried, the unit
  the query implies, and the arrival time. `describeResult(result, display, current)` is the
  one place that turns a result into words: unit, range, chart name, digest title, and
  whether it is stale. It is given the current request only to compare with it.
- `src/explore/ExplorePage.tsx`: the query function stores the identity with the data. The
  panel head (range, unit, age), the axis format and its scale, the legend and table heads
  and cells, the crosshair readout, the chart's accessible name, the digest title, the JSON,
  the "Automatic" unit option and the caption all come from the result on screen. While the
  result does not answer the current request (waiting, cancelled, stopped at 60 s, or the
  range changed) the head says **"Showing the previous query"** (or "time range"), its title
  attribute holds that query, and the caption says "This is the result of the previous
  query, <query>." After an error nothing of the earlier result is shown; a query that then
  waits shows the last result that arrived, described as itself.

**Tests.** `src/lib/describe.test.ts` (7): the unit, digest title and chart name come from
the result whatever query is pending; nothing in the description changes with, or mentions,
the pending query; stale by query and by range; a toolbar unit applies to what is on screen.
`e2e/fixes.cjs`, B1 section (12 checks): waiting (head, legend heads, cells and names, chart
name, range, unit option, caption, the URL, no "cores" anywhere in the panel, the readout,
then the digest title, table head and JSON), cancelled (all of that again, and axe),
answered, errored after success, waiting after an error, and stopped at 60 s.

**Images** (before / after, 1440 px, light): `b1-waiting-*.png`, `b1-cancelled-*.png`,
`b1-errored-*.png`, `b1-stopped-60s-*.png`. In every "before" the memory query
(`pod_memory_working_set_bytes`) is pending over the request-rate chart and the head reads
"bytes (IEC)" with the unit select on "Automatic: bytes (IEC)"; in every "after" the head reads
"Showing the previous query", the range and "per second (/s)", and the select names the
unit of what is on screen.

## B3 (blocker): typing, and the budgets at 36 and 200 series

**Typing.** The page re-rendered on every keystroke because the draft was page state.

- `src/editor/PromqlEditor.tsx`: the editor owns the text; the page reads it when the query
  is run (`handleRef.current.getValue()`), so a keystroke renders no React component. The
  extensions are built once per editor; a new connection reconfigures one compartment. The
  autocomplete list renders 40 options instead of 80 (it shows 8 and is rebuilt on every
  keystroke while open; arrow keys still reach every option).
- `src/editor/promClient.ts`: label and series lookups wait 150 ms, and a newer lookup of the
  same kind replaces an older one: one not yet sent is never sent, one in flight is aborted.
- `src/lib/focusKeeper.ts` (new in this change for M3, then fixed for speed): the observer
  that keeps focus read layout (`getClientRects`, `getComputedStyle`) after every DOM change,
  which put a forced style and layout pass inside every keystroke, every crosshair move and
  every view switch. It now reads layout only when a change can have removed or hidden the
  focused control (`mayLoseFocus`, a pure filter over the mutation records).

**The other budgets.** Profiled with Chrome traces and the CPU profiler on an unminified
build, 4x CPU (the harness is in the session scratchpad, not committed). What was found and
done:

| Where the time went (4x CPU, profiler on) | Change |
|---|---|
| Focus keeper forcing layout after every DOM change: 87 ms over 5 view switches, 78 ms over 60 keys | `mayLoseFocus` filter (above) |
| Router navigation for the `view` param, 20 to 45 ms, ran in the task after the switch and delayed the next frame | the URL follows 300 ms after the last switch (`pagehide` flushes it) |
| `alignMatrix` at 200 series: 145 ms per response (destructuring iterators, a separate grid pass, `parseSampleValue`) | one indexed pass that checks the grid while filling; property-tested equal to the old function (`src/lib/series.test.ts`, 500 cases) |
| `nameSeries` at 200 series: 40 ms, trying five truncation lengths that cut nothing | lengths no value reaches are skipped (same output) |
| The digest and the JSON text recomputed every time their form was shown | cached per result (`WeakMap` on the result) |
| `matchMedia` called on every render by `useCoarsePointer` | one `MediaQueryList` |

Already in place before this session's part and kept: the chart stays mounted while another
form is shown; new data for the same series goes into the existing plot; the default Other
policy draws at most eight series; the crosshair readout is written to the DOM by uPlot's
hooks, outside React; the legend has at most eight coloured rows and one Other row (members
listed 50 at a time); the table renders 50 rows at a time; the digest is computed only for
the text form and the JSON only for the JSON form.

**Measurement.** `e2e/measure.cjs`, extended: a 60-character query typed one key at a time
(keydown to the end of the next frame, each key waited for), the crosshair (30 moves), 36
series from the mock and 200 synthetic series, and `responseFull` (below). Chromium, CPU 4x,
Fast 4G, 1440x900, a fresh context per run, 75th percentile of 20 runs (median, maximum).
Before is the app as it was when the review was written (the session's copy of it), after is
this change; both built against the same snapshot of `design-system/dist` (the system was
being edited during the session), measured here in alternating batches of five runs because
the machine was shared: load average LOAD_RANGE on 4 cores during the runs. Numbers measured
on an idle machine would be lower. `node e2e/summarise.cjs` prints these tables from
`e2e/measurements/fixes-{before,after}-{4,36,200}.json`.

A correction to the harness: its "response" figure starts when the harness's copy of the body
(`res.clone().text()`) resolves, and that happens after the app has read and parsed its own
copy (checked in a page: the app's `text()` resolves first and its `JSON.parse` runs before
the clone's callback). So "response" leaves out parsing the body. `responseFull` is measured
from the last byte (Resource Timing `responseEnd`) and includes it.

SPEED_TABLES

## M3: focus dropped to the body

**What changed.** `src/lib/focusKeeper.ts`, installed once in `src/shell/AppShell.tsx`: when
the focused control is removed or hidden, focus moves to the control named in its
`data-focus-after` (Cancel names Retry, Retry and "Run the query again" name Run query,
"Show all series" names the first legend row, the empty state's button names the time
range), else for anything in the result region to the pressed "Show as" segment, else to Run
query. Focus given up on purpose (a click on empty space) is left alone; dialogs manage their
own focus (the native `<dialog>` returns it to the opener). The time presets return focus to
the range button.

**Tests.** `src/lib/interaction.test.ts`: the fallback order, and `mayLoseFocus`.
`e2e/fixes.cjs`, M3 section: `document.activeElement` is checked after 27 interactions and is
never the body: Cancel and Retry by keyboard and by pointer (Cancel lands on Retry with the
2 px ring), closing the palette with Escape and running a command from it, closing settings
with Escape and saving them, each form by its segment, T with focus in the table and in the
legend, isolating a series and "Show all series", a time preset, an absolute range, Zoom in,
Zoom out, Reset zoom, opening and closing Other, both error-state buttons, the empty state's
button and an example link.

**Images** (top of the page, 1440 px): `focus-cancel-*.png`, `focus-retry-*.png`,
`focus-time-preset-*.png`, `focus-run-again-*.png`, `focus-palette-closed-*.png`,
`focus-settings-closed-*.png`, `focus-view-switch-*.png`, `focus-show-all-*.png` (full
viewport). Where focus is on the body there is no ring to see, so the focused element in
each case is also written to `focus-before.json` and `focus-after.json`:

FOCUS_TABLE

## M5: names that hide what distinguishes the series

**What changed.** `src/lib/naming.ts`, `nameSeries(labelSets)`: labels with one value across
all series are dropped and returned once as `common`; the rest are ordered by distinct-value
count, most first, ties by name; one distinguishing label gives a bare value ("checkout");
a label missing on some series is written as a pair, never a bare value; one series and
identical label sets keep the full name; series that differ only in `__name__` are named by
the metric. `short` cuts long values in the middle (both ends kept) and is used only if no
two different series end up alike. Everything depends on the set of label sets, not their
order. The legend shows `short`; the full label set is the row's title and is written under
the table for the row that has focus or was tapped (a tap does not focus a button in every
browser). The table's columns are the distinguishing labels in that order, with the common
labels once in its caption. The text digest and the JSON use full names.

**Tests.** `src/lib/naming.test.ts` (13, three of them properties over random label sets,
500 and 300 cases): two series share a name, in any of the three forms, only when their label
sets are equal; names do not depend on order; no name contains a common label. `e2e/fixes.cjs`:
legend names lead with the most distinguishing label and carry the full set as title; a long
CPU label set is shown by what distinguishes it and its full name appears on focus; the text
view names every series by its full label set; a tap shows the full name.

## M7: units

**What changed.** `src/lib/units.ts`: `formatParts` returns `{ value, unit }`;
`columnFormat(values, unit)` decides where a column's unit goes: once in the head with every
cell a number in one scale, or, when the column needs scales one head cannot describe (2 ms
beside 3 h), on every value and not in the head. `axisUnitLabel` states the axis unit once,
in the panel head ("bytes, in MiB"); ticks are numbers in that scale. CPU cores carry their
unit ("1.42 cores", "357 millicores"). Byte axes tick on powers of two. Readout, legend and
digest use the same three significant digits.

**Tests.** `src/lib/units.test.ts` (10). `e2e/fixes.cjs`: request rate "Last, /s" with bare
cells; memory "bytes, in MiB" and "Last, MiB"; CPU cores in the head and each column head,
cells in one scale; the readout carries the unit at the legend's precision; the table's
"Value, /s" head and the shared timestamp once in its caption.

## M2 (mechanism): which series get a colour

**What changed.** `src/lib/assign.ts`, pure `assignSeries(series, previousAssignment,
policy)`: a series that already has a slot keeps it; free slots go in palette order to the
others in order of appearance; when more want a slot than are free they are ranked by the
policy's size measure (default: mean over the result's window; ties by name, then key) and
the rest fold into ONE Other group; `policy.other` is `'list'` (default: listed, not drawn)
or `'sum'` (the group carries a sum to draw, right only for values that add up). The view
remembers the assignment in `sessionStorage`, so a filter keeps the survivors' colours and a
reload reproduces them. The legend shows one row "Other, N series" that opens to list the
members (50 at a time); members are drawn, as hairlines in `ink-muted`, only when selected.

**Tests.** `src/lib/assign.test.ts` (13, two properties over random series and remembered
assignments): palette order by appearance; survivors keep their slots after any filter;
re-applying changes nothing; a reload (fresh, or through storage) reproduces; never more than
eight coloured (asserted as the literal 8, not the constant), distinct slots, every series
coloured or in Other exactly once; the largest by mean are coloured; the measure, ranking and
Other policy are parameters. `e2e/fixes.cjs`: series-1 to series-4 in order; survivors of a
filter keep their colour; a reload reproduces; with 36 series eight coloured, each on its
own token, and the other 28 as ONE legend row.

## M4 (logic): touch

**What changed.** `src/lib/pointer.ts`, `additiveToggle`: a touch or pen press, or any press
on a coarse primary pointer that is not a mouse, toggles the row with no modifier key; the
legend's hint on touch says "Tap a series to hide or show it." `src/explore/TimeRangePicker.tsx`:
Zoom in (half the range around its middle, never under a minute), Zoom out (twice, never past
now) and Reset zoom (back to the range before the first zoom), next to Show earlier and Show
later. **Their placement is provisional**, for the system migration to settle with the
chart's range control.

**Tests.** `src/lib/interaction.test.ts` (`additiveToggle`, `zoomedIn`, `zoomedOut`).
`e2e/fixes.cjs` on an emulated phone: a tap hides a series and a second tap shows it; the
hint has no Shift; Zoom in, Zoom out and Reset zoom change the URL's range as stated; axe.

## Minors (wording and logic)

| Review | Now | Test |
|---|---|---|
| m1 "returned in 118 ms" in the panel | moved to the JSON form's caption ("answered in N ms") | `e2e/run.cjs` JSON check |
| m2 the "At" column repeats one time | said once in the table caption; a column only when the times differ | `e2e/fixes.cjs` M7 table check |
| m3 "updated 0 s ago" | "updated now" under 5 s | `interaction.test.ts` |
| m3 the range missing from the head | the result's range is in the head | `e2e/fixes.cjs` B1 |
| m3 "The range now is fixed." | "This range is fixed." / "This range follows the clock." | |
| m3 "auto, 15s" beside "15 s"; "every 1 m" | "auto, 15 s"; steps read "1 min" | `interaction.test.ts` (`stepWords`) |
| the same metre reading in the presets ("Last 5 m") | "Last 5 min", also in the palette and the 10 s alternative | `interaction.test.ts` (`spacedDuration`) |
| m3 "Still waiting. Try a shorter range." with no control | after 10 s a "Show the last 1 h" (or 5 min) button, only when a shorter preset exists | `interaction.test.ts` (`shorterRange`) |
| m6 keyboard announcement silently cut at three series | adds "and N more series" | |

The noun buttons "Commands" and "Settings": the review calls them acceptable and gives no
wording, so they are left for the navigation component.

## Mutants

MUTANTS_TABLE

## Changes to the existing suites

No check was deleted. `e2e/design.cjs`: "a press paints the pressed token fill" expected the
`rule` token; while this session ran, the system added a `pressed` token and moved
`.vz-segmented button:active` to it, so the check now expects `pressed` when the system
defines it and `rule` before. `e2e/measure.cjs` gained the typing, crosshair, 36- and
200-series cases (earlier in this change) and `responseFull`. `e2e/mutants.cjs` gained the
`fixes` set (`MUTANTS=fixes`); the original set runs as before.

## Verification

VERIFICATION_TABLE

## Left for the system migration

Styling and chart-drawing findings, and anything that needs a new token or component:

- **B2** the query well on a coarse pointer (`control-touch` tall, `body` text): `vz-query`.
- **M1** direct labels: placement in a right-hand gutter with ticks, the fallback when a label
  does not fit (the names they should show now come from `nameSeries`).
- **M2** drawing Other as a min-to-max band with a `series-other` token; the series contrast
  fixes; the system's statement of the assignment rule (the mechanism above takes the rule as
  a policy).
- **M4** the readout below the plot under 640 px of plot width; the final place of Zoom in,
  Zoom out and Reset zoom.
- **M5** the legend's layout: the full name wrapping to a second line in `ink-secondary`.
- **M6** pressed states on legend rows, sortable heads and quiet buttons.
- **M8** `data-size="sm"` toolbar controls and the reserved waiting line.
- **m4** native date inputs; **m5** the centred range button at 400 px; **m7** arrow keys
  within the segmented control and the legend (a change to the keyboard model of system
  components); **m8** the ring clipped on the last legend row; **m9** the settings gap and
  scrim; **m10** the palette field's visible label; **m11** an image of the 10 s wait.
- The noun buttons "Commands" and "Settings".
- Units in charts (review, system item 10): this change puts the axis unit once in the panel
  head; the system may place it elsewhere.

BUDGETS_MISSED
