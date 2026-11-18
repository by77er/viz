# Design review: make the web app use the design system

Reviewed 2026-11-18 against `design-system/project/review.md`, by a reviewer who did not write
the change. Worked from `PR.md`, the images under `before/`, `after/`, `compare/`, the design
system, and the running app (built here, served on 8870 with the mock on 8871, driven with
Playwright and axe-core 4.14).

## Verdict: reject

Three blockers and eight majors. The rubric's definition is "any blocker, or three or more
majors", so the change is re-imaged and reviewed again after the fixes.

The restyle itself is largely sound: every computed colour, type style, radius and transition
I sampled is a token value, there is one blue button in every view, the waiting table is
implemented accurately, and keyboard and screen-reader basics hold. What fails is behaviour the
author's checks did not look at: old data relabelled as a new query while it waits, the query
editor on touch, a budget that was never measured, and a chart whose direct labels point at
the wrong lines.

## How this was checked

- 72 full-page captures: 15 views and 3 overlays, light and dark, 1440 and 400 px. Also 200%
  zoom (720 px CSS at scale 2), 320 px, and greyscale and blurred copies of the main view.
- Keyboard-only run of the main flow in both themes, 47 stops each, ring read from computed
  style and pictured at each stop.
- Hover, pressed (pointer held) and busy for nine control types under 4x CPU throttling.
- Waiting at 150, 405 to 650, 800, 3000 ms, 12 s, 30 s (cancelled) and 75 s (stopped at 60 s).
- Emulated phone (coarse pointer, touch, 400 px): hit area of every control measured by
  `elementFromPoint` scans, touch drag on the chart, taps on the legend.
- Computed-style audit of 12 views per theme; contrast computed for 54 pairings per theme.
- axe-core on 18 states per theme (36 runs).
- The author's harness, copied unchanged except for ports and output path, plus two
  measurements it lacks (character echo in the editor, crosshair frame).

Images cited as `review-images/…` are mine and sit beside this file. Images cited as
`after/…` or `compare/…` are the author's.

Not checked: a screen reader by ear, Safari and Firefox, real touch hardware, enlarged text
as distinct from zoom.

## Rubric

| Area | Result | Evidence |
|---|---|---|
| Purpose | Fail, major (single elements) | "returned in 118 ms", the "At" column, the Shift hint on touch, 120 legend rows that each say "Other". Zoom in has no control. See M2, m1, m2. |
| Tokens | Pass | `check.mjs app/src`: contrast 122/122, 0 literal values in 37 files. My audit found no computed colour, font size, radius or transition outside the tokens in either theme. |
| Colour | Pass | One blue button in every view (none on Help). Colour appears only on Run query, status marks and series. No capitals, no tracking beyond the heading styles. |
| Contrast | Pass for text, borders, ring; series below the mark floor | All text pairings are at least 4.55:1, control borders at least 3.17:1, the ring at least 4.68:1. On the light ground series-3, 4 and 5 are 2.82, 2.17 and 2.69:1. The system's token notes allow this with a direct label or table, so it is recorded under M2 and as a system change, not as a blocker. |
| Type | Fail, major | Only defined styles are used. But values a person compares carry the unit on every cell and tick, or none at all (M7). |
| Hierarchy | Fail, major | `review-images/06-greyscale-explore-light-1440.png`: Run query is first, then the toolbar's four bold bordered buttons, then the chart. The largest series is the palest mark. See M8. |
| States | Fail, major | Focus and error are designed and imaged. Pressed is missing on legend rows, sortable heads and quiet buttons (M6). |
| Keyboard | Pass, with one major | 47 stops in reading order, a 2 px ring at each, in both themes. Cancel drops focus to the document (M3). |
| Screen reader | Pass | 0 axe violations in 36 runs. Names and roles are correct. The waiting line announced once in 10 s (at the 10 s stage change); the timer is hidden. |
| Speed | Fail, blocker | Typing in the editor misses the 50 ms budget in 17 of 20 runs and was not measured. With 36 series two more budgets miss at the 75th percentile (B3). |
| Feedback | Fail, blocker | A pending, cancelled or stopped query shows the old data under the new query's unit and name (B1). |
| Touch | Fail, blocker | The query editor is 32 px tall with 13 px text on a coarse pointer (B2). All other controls measure 44 px with no overlap. |
| Narrow and zoom | Pass | No sideways page scroll at 400, 320 or 200% zoom; smallest text 11 px. Content problems at those widths are M1 and M5. |
| Reduced motion | Pass | No element keeps a transition or animation; nothing is lost. |
| Text form | Pass | The digest carries last, min, max, mean, trend and gaps per series, largest first. It inherits B1 while a query is pending. |
| Charts | Fail, major | Direct labels sit on the wrong lines and collide at 400 px (M1). Colour order and the Other treatment (M2). Rollup is stated. |
| Words | Fail, major | Numbers without units (M7). Minors under m3. |
| Detail | Minor findings | m4 to m9. |
| System | Pass | No new token or component; eight gaps are listed as proposals. |

## Blockers

### B1. Old data is shown under the new query's unit and name

Rule: Feedback, accurate: "Do not present old data as current". Rubric: Feedback, blocker if
inaccurate. Image: `review-images/01-pending-query-mislabelled-light-1440.png`.

Run the request-rate query, then type `pod_cpu_usage_cores{service="checkout"}` and run it
with a slow backend. While it waits, the panel head reads "CPU cores · updated 12 s ago" above
the request-rate chart, and the legend's "136/s" becomes "136". With the memory query the
legend reads "136 B, 117 B, 171 B". The chart's accessible name says "Chart of 4 series for the
query pod_cpu_usage_cores…", and the text form is titled with the new query over the old
figures. After Cancel or the 60 s stop the line says "The previous result is shown" and the
mislabelling stays until the next successful run.

Cause: `app/src/explore/ExplorePage.tsx` derives `unit`, `format`, `chartLabel` and the digest
title from `search.q` (lines 157 to 159, 292, 298), while `result` is the previous query's data
kept by `keepPreviousData`.

Fix: store the query text in `RangeResult` inside `queryFn`, and derive unit, formatters, the
chart name and the digest title from `result.q`. While `result.q !== search.q`, say so in the
panel head: "Showing the previous query · updated 12 s ago". Add a check to `e2e/design.cjs`
that changes the query under a 3 s delay and asserts the head, a legend cell and the digest.

### B2. The query editor is below the touch size and will zoom the page

Rule: Every form factor: text inputs become `control-touch` tall with `body`-size text.
Rubric: Touch, blocker. Image: `review-images/05-touch-readout-covers-chart-light-400.png`
(the well beside Run query).

On the emulated phone the query well measures 32 px tall and its text 13 px. It is the main
input of the view. The author's hit-area check does not include it.

Fix: in `app/src/app.css`, under `@media (pointer: coarse)`, give `.query-well`
`min-height: var(--control-touch)` and its `.cm-content` `font-size: var(--text-body-size)`.
Add the well to the hit-area check. The system should carry this rule in `vz-query`.

### B3. A budget is missed and was not measured

Rule: Responsiveness budgets: "types … paint the character in the first frame, input delay
plus processing at most 50 ms". Rubric: Speed, blocker. Evidence: the speed table below.

- Character echo in the editor: 82 ms at the 75th percentile (median 61, maximum 126), over
  50 ms in 17 of 20 runs. The old app measured 100 ms, so this predates the change, but the
  restyle reports the budgets as met without measuring it.
- With the PR's own 36-series view: chart to table 102 ms, response to paint 119 ms, crosshair
  68 ms at the 75th percentile.
- With 128 series: a 398 ms task on load, and table switching at 200 ms.

Likely cause of the typing figure: `onChange={setDraft}` re-renders the whole `ExplorePage`
on every keystroke, and lint and autocomplete run on the same thread.

Fix: keep the draft in the editor (a ref, read on run) so a keystroke renders nothing outside
CodeMirror; defer lint. Render the legend and table in a window of rows. Add typing, crosshair
and a 36-series run to `e2e/measure.cjs`. A second reviewer may waive the typing part as
inherited; it should not be reported as passing.

## Majors

### M1. Direct labels name the wrong line, and collide at 400 px

Rule: Panel: "Label up to four series directly". Rubric: Charts. Images:
`review-images/02-direct-labels-wrong-line-dark-1440.png`,
`review-images/08-direct-labels-wrong-line-light-320.png`,
`review-images/03-direct-labels-collide-light-400.png`, and the author's own
`compare/rollup-and-gap-light-400.png`.

In the CPU chart the label for node-b sits directly on the red line, which is node-c; the
node-c label is stacked beside the violet line. In the p95 chart at 320 px "catalog" sits on
the checkout line and "auth" on the catalog line. At 400 px three long labels are drawn on top
of each other and cannot be read. During an incident this is worse than no label.

Cause: `drawLabels` in `app/src/charts/TimeSeriesChart.tsx` pushes a label above any line
under it, so each label climbs to the next line up; all labels clamp to the same top edge.

Fix: put labels in a right-hand gutter at each line's last value, nudged apart, each with a
short tick in `ink-muted` to its line end. Use the shortest distinguishing value, truncated in
the middle, at most 40% of the plot width. If a label cannot sit nearer its own line than any
other, draw none and leave it to the legend.

### M2. Colour assignment and the Other treatment

Rule: Colour: "`series-1` to `series-8`, in that order, assigned to the entity and kept when
filters change. A ninth series folds into Other". Images:
`review-images/04-many-series-other-light-1440.png`, `review-images/07-128-series-readout-light-1440.png`.

What the hash gets right: I confirmed that auth keeps series-6 and orders series-1 when the
filter changes. What it gets wrong:

- The order is not fixed. One series alone is drawn in series-6; the four-series view uses 6,
  5, 8 and 1; the three-series view 7, 3 and 8. The reference's blue, orange, green never
  appears. The largest series in the main view lands on series-5 at 2.69:1.
- Collisions move a series to the next slot, so the same entity changes colour between
  queries, which the README admits.
- Which eight are coloured follows sort order. With 36 series the three largest (295, 171 and
  112 per second) are grey hairlines and the coloured lines hug zero.
- "Other" is 28 or 120 separate legend rows, each a tab stop (160 on the page with 128 series).

What is right: assign slots in the fixed order as entities first appear in the view, keep an
entity's slot while it stays in the view, and remember the map for the session so a filter
change does not reshuffle. Choose the eight by a stable rank (maximum over the window at
first assignment), not by name. Draw the rest as one "Other" entry: a min to max band in a
neutral token, one legend row "Other, 28 series" that expands. Not summing is correct.

Fix: `app/src/lib/color.ts` (`assignStyles`), `Legend.tsx`. The band and its token need the
system (see below).

### M3. Cancel drops keyboard focus

Rule: Feedback, useful: "Keep focus and scroll position where they were". After pressing
Cancel by keyboard, `document.activeElement` is the body; the next Tab starts from the top.
Fix: in `halt` in `ExplorePage.tsx`, move focus to the Retry button, which replaces Cancel in
the same place.

### M4. Touch cannot do what the pointer can

Rule: "Charts read by touch"; nothing depends on hover (or a key a phone lacks). Image:
`review-images/05-touch-readout-covers-chart-light-400.png`.

- Adding a series to the selection needs Shift or Ctrl, and the hint says so on a phone.
- There is no way to zoom in by touch or keyboard: drag-to-zoom is mouse only, and the
  controls only shift and zoom out.
- At 400 px the readout covers three quarters of the plot, including the line it reports.

Fix: on a coarse pointer make a legend tap toggle that series and drop the Shift sentence. Add
a "Zoom in" button beside "Zoom out" in `TimeRangePicker.tsx`. Below 640 px of plot width, put
the readout in the caption row under the chart, not over it.

### M5. Long label sets hide what distinguishes them

Rule: Method: "Truncation never hides the part that distinguishes one item from another".
Images: `review-images/03-direct-labels-collide-light-400.png` (legend rows end at
`node="noc`, the Last, Min and Max columns are off screen), `review-images/07-128-series-readout-light-1440.png`
(ten readout rows all reading `http_request_duration_…`).

The legend's figures are the third item of the stated reading order and are not visible at
400 px or at 200% zoom without scrolling the table sideways.

Fix: in `Legend.tsx` show the distinguishing labels first and let the full name wrap to a
second line in `ink-secondary`. In the readout truncate in the middle.

### M6. Pressed state missing on three control types

Rule: States: every interactive element defines pressed. Measured with the pointer held:
legend rows, sortable heads and the quiet nav buttons (Commands, Settings) look the same
pressed as hovered. Fix: `.series-toggle:active` and `.th-button:active` in `app.css` with
`background: var(--rule)` and no transition. The quiet button is a system bug (below).

### M7. Units

Rule: Type: "Put the unit in the column head or after the number in `ink-secondary`, once".
Words: numbers carry units. Rubric: a number without a unit is major.

Request rates carry "/s" on every tick, every legend cell and in the panel head. CPU cores
carry nothing and mix "357m" with "1.42" in one column. The readout shows four significant
digits where the legend shows three. Byte axes tick at 858.3, 762.9 and 667.6 MiB.

Fix: `app/src/lib/units.ts` and `Legend.tsx`: unit once in the column head ("Last, /s"), one
scale per column, binary-round ticks for bytes, the same precision in readout and legend.

### M8. The toolbar outranks the chart

Rule: Space and shape: controls are `control-sm` in toolbars; Button: `data-size="sm"` inside
toolbars. Image: `review-images/06-greyscale-explore-light-1440.png`. The toolbar uses
full-height controls with strong labels. Fix: `data-size="sm"` on Show earlier, Show later and
Zoom out in `TimeRangePicker.tsx` (touch height is unaffected), and remove the empty reserved
line so the chart starts under its title.

## Minors

- m1. "returned in 118 ms" answers no question in the presence table. Remove or move to JSON.
- m2. The table's "At" column repeats one timestamp on every row. State it once in the caption.
- m3. Words: "updated 0 s ago" straight after a run (use "updated now" under 5 s). For a fixed
  past range the age is of the fetch, not the data: add the range to the head, as Panel asks.
  "The range now is fixed." is unclear ("This range is fixed"). "auto, 15s" beside "15 s"
  elsewhere. "one point every 1 m" reads as a metre. "Still waiting. Try a shorter range."
  offers no control and appears even at 5 minutes: offer "Show the last 1 h" as the action.
- m4. The time inputs show "11/18/2026, 09:30:00 AM" beside ISO 24-hour times elsewhere.
- m5. The time range button centres its text at 400 px. Layout: nothing is centred.
- m6. The chart announces only the first three series by keyboard and does not say so.
- m7. Each segment and each legend row is its own tab stop. Use arrow keys within the group.
- m8. The focus ring on the last legend row is clipped at its bottom edge by the table wrap.
- m9. Settings: an unexplained 50 px gap above the actions; the page's blue button shows
  beside the dialog with no scrim.
- m10. The command palette field has no visible label (Field: the label is always visible).
- m11. The 10 s and 60 s waits were not imaged. They work: stopped at 60.2 s, request aborted.

## The six questions

1. **System or reskin?** The surface matches the reference. Leftovers from the old look: the
   hashed colour assignment with only its palette swapped; the unbounded per-series legend;
   full-height toolbar controls; native date inputs with a calendar icon and 12-hour format;
   the compact "15s" durations; the centred range button; the "At" column; the query-time
   caption; the dashed crosshair; Settings as a dialog.
2. **Presence test.** Unjustified: m1, m2, the Shift hint on touch, the per-row "Other", the
   unit stated three times, the reserved empty line. Missing: zoom in, the range in the panel
   head, a way to choose which series are coloured. The greyscale image delivers step 1 only.
3. **Chart.** Gaps, rollup caption, gridlines, baseline, axis text and crosshair by keyboard
   are right. Labels (M1), colour and Other (M2), units and ticks (M7), touch (M4) are not.
4. **Honesty.** B1 is untrue. The age is correct and keeps counting through waits, cancel and
   stop. Progress is unmeasured and says so. Nothing is faked.
5. **Words.** M7 and m3. The noun buttons "Commands" and "Settings" are acceptable minors.
6. **The author's list.** Agreed and the app's fault: units, sort-order colouring, Shift on
   touch, the reserved line (overlay the waiting line instead of reserving it). Agreed and the
   system's: proposals 1 to 9 and all eight additions. Disagreed: "every 75th percentile is
   inside its budget" holds only for four series and without typing. Missed: B1, B2, B3, M1,
   M3, M5, M6, and the two system bugs below.

## Speed

Chromium, CPU 4x, Fast 4G, 1440x900, fresh context per run, 75th percentile (median,
maximum). Load average 6 to 9 during my runs, 8 to 12 during the author's. The harness
measures what it says, with two limits: "press" times the first frame after pointerdown
without checking the fill is in it (I checked the fill separately: it is), and it has no
typing, focus or crosshair measurement.

| What | Budget | Author, after | Mine, 4 series, 20 runs | Mine, 36 series, 12 runs | Mine, before, 10 runs |
|---|---|---|---|---|---|
| Press on Run query | 50 ms | 23 (20, 84) | 23 (18, 41) | 25 (21, 29) | 21 (17, 22) |
| Click to busy painted | 100 ms | 51 (39, 86) | 56 (43, 79) | 46 (38, 72) | none |
| Chart to table | 100 ms | 64 (54, 150) | 76 (54, 107) | **102** (92, 153) | not a form |
| Table to text | 100 ms | 61 (47, 75) | 57 (49, 97) | 84 (71, 128) | 86 (76, 92) |
| Text to chart | 100 ms | 59 (53, 83) | 60 (47, 97) | 68 (45, 104) | 159 (126, 179) |
| Open the time picker | 100 ms | 73 (67, 94) | 96 (69, 129) | 70 (63, 104) | 87 (81, 101) |
| Response to result painted | 100 ms | 68 (62, 238) | 66 (55, 89) | **119** (105, 168) | 122 (108, 216) |
| Worst interaction (Event Timing) | 200 ms | 64 (56, 80) | 96 (72, 136) | 96 (96, 128) | 136 (112, 160) |
| Character echo in the editor | 50 ms | not measured | **82** (61, 126) | **82** (64, 135) | 100 (72, 158) |
| Crosshair frame | 50 ms | not measured | 44 (33, 54) | **68** (51, 101) | 57 (45, 73) |
| Layout shift, load and run | 0.05 | 0.0000 | 0.0000 | 0.0000 | 0.0175, 0 |
| Shell script, gzip | 200 kB | 146.1 kB | 146.1 kB | | |

My worst-interaction and input-delay figures include the typing I added, so they are not
comparable with the author's row. The author's table reproduces for the four-series page:
every figure agrees within the noise of a shared machine, and the improvement over the old
app is real (text to chart 159 to 60 ms here). Single runs over budget on four series: chart
to table once (107 ms) and the time picker five times (102 to 129 ms), both from machine load
as far as I can tell.

## Changes the design system needs

1. **Series assignment.** "In that order" and "assigned to the entity" conflict once a filter
   changes. State the algorithm (M2).
2. **Other.** Define it: which series fold, how they are drawn, a `series-other` token, one
   legend row. Say what to do when a sum is meaningless.
3. **Series contrast.** series-3, 4 and 5 are below 3:1 on the light ground, and series-2 is
   2.73:1 on a hovered row. Darken them or reorder so the first four pass. Add series on
   ground, hover and raised to the pairings in `check.mjs`.
4. **`.vz-button[data-quiet]:hover` outranks `:active`**, so quiet buttons have no pressed
   state. New finding.
5. **`[aria-busy="true"]` eases** over `duration-fast` when a run starts from the keyboard.
   Add `transition-duration: 0s`. New finding.
6. **`vz-query` on a coarse pointer**: `control-touch` tall, `body`-size text (B2).
7. **Direct labels**: a placement rule and the fallback when a label does not fit (M1).
8. **Chart readout, brush and crosshair** components or guidelines, including where the
   readout goes on a narrow plot.
9. **The waiting line**: say whether its space is reserved or it overlays the region's top.
10. **Units in charts**: say where the unit goes for axis ticks, legend and readout.
11. The author's items, all agreed: closed `<dialog>` shown, monospaced inputs on touch, button
    menu rows, nav gutter under 640 px, `vz-empty` top padding, sortable head, checked menu
    row, inline `vz-num`, scrim, skip link, "min" for minutes, `shots.mjs` states, `check.mjs`
    lengths in TypeScript.
12. **The fixture dashboard and a shared speed harness** that covers every budget row,
    including typing and the crosshair.

## Keep

- Tokens only, Tailwind and uPlot's stylesheet removed, fonts self-hosted and preloaded.
- One blue button; selection never blue; status by shape and word.
- The waiting implementation: nothing before 400 ms (shown at 403 to 407 ms), held 303 to
  311 ms, Cancel at 2.03 s, the alternative at 10 s, stop at 60 s, a real abort
  (`net::ERR_ABORTED`), a second press ignored, the old result usable, scroll kept, the age
  counting, one announcement per stage.
- Chart, table, text and JSON as forms of one result; the text digest.
- The chart kept mounted between forms, and the layout-shift work (0.0000).
- Gaps drawn as gaps; the rollup caption with its point counts.
- The keyboard order, the ring on every stop, focus returning from overlays.
- The presence-test removals, and the honesty of the author's own shortfall list.

## Housekeeping

I rebuilt `design-system/dist` and `app/dist` as instructed and wrote only this file and
`review-images/`. The servers I started (8870, 8871, and 8872 for the old build) are stopped.
The author's `e2e/measurements/*.json` are untouched; my raw runs are in the session
scratchpad and will not survive it.
