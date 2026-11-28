# Review: viz design system, v5

Reviewed 2026-11-19 against `project/review.md`, by a reviewer who did not write the revision and was
not given the author's reasoning. Inputs: the system on disk (`project/`, `src/components.css`,
`tools/`, `fixtures/`), the v4 review and its images, the before/after pairs in `compare/` and the
compositions in `compositions/`. `response.md`, the author's account, was read only after every finding
below was written, and only to check its claims (last section). Every image cited here was rendered here,
in `review-images/`.

## Verdict: reject

Two blockers and seven majors. The rubric: "Reject: any blocker, or three or more majors."

v5 fixes most of what v4 rejected, and fixes it properly: a chart now reserves its exact height on a
phone (layout shift 0.0000 at every width and pointer I tried, loaded scrolled to every region), the
second channel is real (lightness step, dashed slots 5 to 8, emphasis from the legend), the main path is
never inside a sentence, previews carry no inline style except data, and the pieces the flows needed exist. The
interface is calm, neutral and legible in both themes; I saw none of the generated-design tells v4 listed.

What fails is again what only shows when pieces are combined or a sequence is played out:

- **B1.** v4's filter round trip is fixed, but the Chart rules still give a reserved slot to the next new
  series, so a filtered-out series returns grey whenever anything new appeared meanwhile, and editing a
  query and editing it back leaves nothing coloured at all (images `01`, `02`).
- **B2.** At 400 px the system's own Table preview, and the reference page, scroll sideways by 169 and
  177 px; at 200% zoom the dialog composition does by 38 px. The cause is one line: the visually hidden
  "Actions" head escapes its scrolling table. And in a folded list a state word is cut ("Burning bu") and
  the row's "Actions…" is 11 of 72 px on screen (images `03`, `04`, `05`).

Nothing should be built on the series-assignment rules until B1 is answered. Everything else in v5 can
be built on now, with B2's small fixes.

## How this was checked

- Built in a copy of the system in the session scratchpad (`tools/build.mjs`, `tools/reference.mjs`,
  `fixtures/build.mjs`): every generated file was byte-identical to what is on disk (md5). The tree was
  not touched except for this file and `review-images/`.
- `tools/check.mjs` on the system (589/589, rendered audit 0 failures, 0 literals), on `project/components`,
  the compositions and `fixtures` (0 literals each). 32 mutants of my own against it, on copies.
- Rendered with Playwright (Chromium headless shell, one browser at a time, scale 1): all ten author
  compositions and one of my own (a firing monitor: page state, Acknowledge with a failure notice,
  "Silence…" in a menu anchor, an agent banner, a 36-series chart with the time-range field and presets, a
  40-row folded table with key links, middle cuts and row actions, an empty and an error panel, a timeline
  with its main-path link, a related-links list and a field whose help line holds a link), each in both
  themes at 1500 px with a fine pointer and 400 px with a coarse pointer and touch; the same at 200% zoom
  (720 CSS px at 2x) and 320 px for overflow; every preview page at 400, 320 and 720 at 2x.
- The Chart preview driven through sequences: filter round trip; filter, new pod, clear; query edited to
  another service and back (`setData`); a member of Other above a threshold; values below zero; the number
  format's edge cases.
- Hit areas with my own `elementFromPoint` scan (any link whose block has other text counts as in a
  sentence, not only links in a `p`), keyboard tab walks with a ring check on every stop, reduced motion.
- Layout shift: my own probe on the fixture with responses held 1.5 s, loaded at the top and scrolled to
  each of the six regions, at 400 and 360 px coarse, 320 coarse, 660 coarse, 1024 coarse, 400 fine and
  720 at 2x; and `tools/speed.mjs fixtures/speed-phone.json --runs 3`.
- Press feedback by finger: touch held on the Run button by CDP touch events, a synthesized long tap, a
  quick tap and a mouse press, polling `:active` and the fill every frame.
- Palette: the dataviz validator on both palettes, both themes, six surfaces, adjacent and all pairs, and
  for each dash group separately (72 runs); WCAG ratios; luminance ratios between slots.
- Machine: 4 cores shared with other sessions' builds; 1-minute load 4.8 to 20.3 during this review, 17.9
  to 18.3 during the speed run (calibration task 834 ms against "about 100 ms idle"). **No timing measured
  here can be judged**; every number below says so. Layout shift and the mechanism findings (a press that
  never paints) do not depend on load.

Not checked: a screen reader by ear, Safari and Firefox, real touch hardware (the press finding below
is from Chromium's touch emulation), enlarged text as distinct from zoom, `tools/mutants.mjs` end to end
(its 31 mutants at about 45 s each under this load; see the claims section).

## Images

| File | Shows |
|---|---|
| `01-b1-filter-and-new-pod-largest-returns-grey-light-1440.png` | 36 series: "Without the three largest", a new pod arrives, filter cleared. The largest pod (…3742c, 3.0 cores) is grey inside Other; the new pod holds its blue slot 1 |
| `02-b1-query-round-trip-nothing-coloured-light-1440.png` | The same chart after its query was edited to another service's pods and back: one grey band, no line, "36 in Other are now larger than a coloured series" |
| `03-b2-table-preview-page-scrolled-sideways-400.png` | The Table preview at 400 px, page scrolled 169 px sideways into nothing |
| `04-b2-folded-list-state-cut-actions-offscreen-400-coarse.png` | The dialog composition's list, dialog closed, 400 px coarse: "Burning bu…", and the third row's "Actions…" off the right edge |
| `05-b2-dialog-composition-200pct-zoom-page-wider-than-window.png` | The dialog composition at 200% zoom: the page is 758 CSS px wide in a 720 px window |
| `06-text-form-other-above-threshold-light.png` | A member of Other above a 3.5-core threshold; the text form for this state says "no series above it" |
| `07-negative-values-drawn-over-axis-and-legend-light.png` | Values below zero: the lines run through the time axis, the zoom buttons and the legend |
| `08-link-in-list-and-help-line-breaks-its-line-400-coarse.png` | A link inside a list sentence and inside a field's help line, 400 px coarse: each line opens to 44 px |
| `09-dashboard-figures-disagree-light-1500.png` | The dashboard composition: stats, the latency chart and the slowest-routes table give different figures for the same routes |
| `10-dialog-list-caption-order-ages-light-1500.png` | "12 dashboards, most recently changed first" over three rows, "12 d ago" before "3 d ago" |
| `11-error-after-draw-blank-plot-dark-1500.png` | An error after a result was drawn: 130 px of nothing where the plot was, under "Showing the previous query" |
| `12-key-links-with-cut-lose-underline-light-1500.png` | Key links holding a `vz-cut` have no underline |
| `13-reviewer-composition-firing-light-1500.png`, `14-…-dark-400-coarse.png` | My composition, full page |
| `15-dashboard-dark-400-coarse.png`, `16-states-empty-error-light-400-coarse.png` | The author's dashboard and empty/error compositions as rendered here |

## The v4 findings, checked

| v4 | Now | Evidence |
|---|---|---|
| B1 colour after a filter round trip; "highest" over coloured only | **Partly** | The round trip v4 played is fixed (slots 1 to 3 come back; note "8 coloured by size when first seen; 28 in Other"). "Highest" covers every drawn series and names a member of Other ("highest: Other, …new01"). A filtered-out series still returns grey when a new one appeared meanwhile, and a query round trip greys everything: **B1** below. |
| B2 reserved height on a phone; layout shift 0.30 | **Fixed** | Every panel's reserved height equals its drawn height, and cumulative layout shift is 0.0000, loaded at the top and scrolled to each of six regions with data 1.5 s late, at 400 and 360 px coarse, 320 coarse, 660 coarse, 1024 coarse (tablet), 400 fine and 720 at 2x. `speed.mjs fixtures/speed-phone.json`: every layout-shift row 0.0000. The reservation reads the same custom properties the coarse block sets (`--legend-row`, `--chart-foot`, `--strip`). |
| M1 hue the only channel | **Fixed**, with one rubric question left (M4 below) | Slots alternate darker and lighter (neighbours 1.70 to 1.95:1 light, 1.36 to 1.47:1 dark); 5 to 8 are dashed, in lines and swatches; within each dash group every pair passes the validator on all six surfaces in both themes; the cross-group pairs that fail (dark `series-6`/`series-4` ΔE 0.9 deutan) differ by dash. Emphasis from a legend row (pointer, focus, held finger) draws every other line as a `series-other` hairline. Every slot ≥ 3:1 on ground, raised, sunken, hover and rule in both themes. |
| M2 the chart spec leaves choices open | **Partly** | All ten of v4's open points now have a sentence and a case in the preview ("highest" over everything drawn; several picked members solid/dashed/dotted; sorting with the crosshair set; one direct-label value; two intervals on `plot-sm`; `scaleUnit` and "< 0.1"; zoom without crosshair; the viewer's copy of a panel map; stacked charts excluded; the text form). The panel-map answer opens a new question, and there are new open points: **M2** below. |
| M3 main path inside a sentence, 19 px | **Fixed** | Timeline and Banner put the link after the sentence; my scan of eleven pages at 400 px coarse: 0 controls under 44 px, 0 overlaps, 0 covered at their centre (the page behind a modal excluded). The only links left inside sentences are back-links ("checkout p99 latency" in the report's sub-line, 138 x 18 px), never a main path. A new side effect: minor m1. |
| M4 harness | **Partly** | Frame end, press-then-wait, phone layout, load and calibration all fixed; three budget rows still unmeasured, a phone press is a mouse press, and no timing row has been judged: **M3** below. |
| M5 rubric gives two verdicts | **Partly** | Four of v4's five places fixed; new ones: **M4** below. |
| M6 inline styles in previews; missing pieces | **Fixed** | 0 literals in previews and compositions; the only inline styles are data (`--legend-rows`, a waterfall bar's `--at`/`--len`) and two demo frames' `<style>`. Present: `vz-secondary`, `vz-dialog-text`, `vz-section`/`vz-sections`, `vz-nav-end`, `vz-done`, `vz-menu-anchor` with the bottom sheet (rendered at 400 px), `vz-range`, `vz-row-actions`, empty and error at the plot's height. Two of them do not compose with the folded table: B2. |

v4's minors I re-checked: m1 page state (a block, mark inline: fixed), m2 marker named by the readout
(fixed), m3 interval label cut to its first word ("Firing" at 400 px: fixed), m4 empty readout line
(fixed: the readout lives in the foot), m5 single-series direct label (fixed), m6 Cancel over the plot
(fixed: the strip is `control-touch` tall and the plot starts below it), m11 breakpoints as tokens
(fixed), m12 legend ring round the row (fixed: keyboard walk below), m13 live region on every move
(fixed: 500 ms rest), m14 `.vz-legend` (removed), m15 coarse rows scoped to rows with a control (fixed),
m18 the nav's last items out of view at 400 px (still: "Logs" cut at the edge, image `15`).

## Blockers

### B1. A filtered-out series still returns grey, and a query edited and edited back leaves nothing coloured

Rubric: Many series, "blocker if a colour or a label names the wrong series (… a filtered-out series
returning grey)". Rules: Chart, Series colour 4, 5 and 7. Images `01`, `02`.

v4's case is fixed. The cause has moved to another clause. Rule 4: a new series takes "a slot no series
has ever held in this view, **then the slot of a series that is absent now** (that series is recorded as
in Other, so if it returns it is not new and stays in Other)". Rule 5: "A series that leaves the view
keeps its slot reserved, so it returns in the same colour." As soon as anything new appears while a
series is away, rule 4 wins and rule 5 is false. Measured in the reference implementation, with the
preview's own controls and `setData`:

| Sequence (36-series chart) | Result |
|---|---|
| Without the three largest; clear | Fixed: back in slots 1 to 3; note "8 coloured by size when first seen; 28 in Other". |
| Without the three largest; a new pod appears (pods restart all the time); clear | The largest pod, `…3742c` (3.0 cores), comes back **grey, inside Other**; the new pod holds its blue slot 1. The note says "1 in Other is now larger than a coloured series" (true) and offers "Colour the eight largest". Image `01`. |
| Query edited from checkout-api's pods to search's pods, then back (Explore keeps the map for the tab, across reloads) | **All 36 series in Other, none coloured**: one grey band, no line. The note says "36 in Other are now larger than a coloured series"; there is no coloured series. Image `02`. |

The third is the everyday Explore case (change a matcher, look, undo), and the second is a filter
during ordinary pod churn. Both are the rubric's named blocker; the third also prints a false sentence.

Fix: a series that lost its slot to a new series while it was away keeps a claim on that slot; when it
returns and no *present* series holds the slot, it takes it back (the edit-and-undo case then restores
every colour, and the churn case leaves one series in Other with the note, which is honest). Or do not
hand reserved slots to new series while the filter that removed their owners is applied. Whichever, say
it once in rules 4 and 5 so they agree, give rule 7 a sentence for "nothing coloured", and add both
sequences to the preview and `shots.json`.

### B2. At 400 px and at 200% zoom the Table patterns scroll sideways

Rubric: Narrow and zoom, "does it reflow with no sideways page scroll … no columns a list exists for
behind a sideways scroll" (blocker). Rules: Every form factor, "Nothing scrolls the page sideways";
Table, Fold. Images `03`, `04`, `05`.

1. **The page scrolls.** The Table preview's row-actions column has a visually hidden head, `<th><span
   class="vz-sr">Actions</span></th>`, the head the Table preview gives Menu's row actions. `.vz-sr` is
   `position: absolute`; `.vz-table-wrap` scrolls but is not positioned, so the 1 px span escapes the
   wrap's clip and the document becomes as wide as the table. Measured: the Table preview page is 169 px
   wider than a 400 px window (249 px at 320), `dist/reference.html` 177 px at 400, and the dialog
   composition 38 px at 200% zoom (720 CSS px; its `data-fold` table does not fold above 640 px, so it
   scrolls and carries the span with it). v4 measured 0 at 400 px; this is new with the row-actions head.
   Fix: `.vz-table-wrap { position: relative; }`, then re-measure every page at 400, 320 and 200%.
2. **A folded list cuts its own state column.** In the dialog composition's Dashboards list at 400 px
   (dialog closed), the kept State column is `keep` (26%) wide and `.vz-status` does not wrap, so
   "Burning budget" reads "Burning bu", the rest behind a sideways scroll inside a table that has
   folded precisely so it would not scroll. The row's "Actions…" lands wherever the folded line ends:
   after the age in row 1, on its own line in row 2, and **11 of its 72 px on screen** in row 3. That is
   the only way to rename or delete a dashboard on a phone. Fix: let a status in a kept column wrap
   between words (as `vz-phrase` does for thresholds), and give `td.vz-row-actions` a fixed place in the
   folded form (the end of the key row, or its own line).

## Majors

### M1. The text form leaves out members of Other, so it can say the opposite of the picture

Rubric: Text form, "Does the digest carry the same information as the visual form?" (major). Rules:
Chart, Text form. Image `06`.

With a member of Other above a 3.5-core threshold (the band visibly crosses the line), the text form
reads, in full where it matters:

> Other, 29 series: last < 0.1 to 4.0.
> 3.5 cores limit: no series above it.

`textForm()` tests `m.coloured` only, against each series' maximum; the legend note's "1 in Other is now
larger than a coloured series" is not in the text form at all. A screen-reader user and an agent reading
the digest are told nothing crossed the limit. Fix: test every drawn series, name a member of Other as
the readout does ("Other, …new01"), say whether "above" means at the end or at any time, and carry the
note's sentences.

### M2. The Chart specification is still open in places

Rubric: Charts (major): would two engineers build the same chart. New places where they would not:

1. **Reserved slots**, B1: rules 4 and 5 disagree; the reference follows rule 4.
2. **Values below zero.** "Starts at zero unless the panel says otherwise" does not say whether the
   axis extends below zero. The reference does neither: a series between −120 and 120 is drawn through
   the time axis, the zoom buttons and the legend (image `07`; ticks 0 to 150, lowest point 105 px below
   the plot). Deltas, derivatives and temperatures go negative every day.
3. **"Which series are above it"** (M1): at the end or at any time, coloured or every drawn series.
4. **"One significant digit finer than the step"** at a 2.5 step: 2.5's last digit is tenths, so one
   finer is hundredths; the reference prints tenths (7.4321 → "7.4"). And a small negative value prints
   "< 0.1" (−0.02 at step 1), losing its sign.
5. **"Every viewer opens the panel in the same colours"** holds for series in the stored map only; series
   that appeared since the last save are assigned at each viewer's first sight, so viewers on different
   days see different colours for them. Say what a viewer's copy does with unsaved series.

Fix: one sentence each in the Chart README, and a case each in the preview.

### M3. The speed harness still cannot judge the budgets it exists for

Rubric: Speed (the row is a blocker; the harness's gaps are this major). Rules: Responsiveness, Budgets
and Load.

Fixed, read in `tools/speed.mjs` and seen running: a frame's end is posted from the frame callback in
which the condition matched; after a press the run waits for `body[data-loaded]` to change; the phone
layout is real (400 x 800, touch, coarse, taps and touch drags); the load is recorded per run with the
core count and a calibration task; timing rows are "not judged" when most runs started above the cores;
layout shift is measured loaded scrolled to each chart.

Still wrong:

- **A finger's press is measured with a mouse.** The `press` type calls `page.mouse.down()` in
  `speed-phone.json` too. Pressed by touch, the Run button behaves differently (Chromium headless, touch
  emulation, load-independent):

  | How the button was pressed | `:active` and the pressed fill |
  |---|---|
  | Mouse down, held | 20 ms after the press (8 more runs: median 15, worst 31 ms; load 18 to 20, not judged) |
  | Finger down, held 1.5 s (CDP touch events) | **never**, while the finger is down |
  | Long tap, 1.2 s (synthesized gesture) | **never** |
  | Quick tap | at the release, 19 ms after it |

  The rule "paint the pressed state in the first frame after the input event" is written for every
  pointer, and `components.css` draws presses with `:active` only. Whether a real phone behaves like the
  emulation is not checked here (Android Chrome delays `:active` on touch by its show-press timeout, by
  my training knowledge, not verified). Either set a pressed attribute from `pointerdown` in script, or
  say in the rules what a finger sees, and measure presses by touch on the phone layout.
- **Three of the six budget rows have no measurement**: a local change other than a toggle (open a menu,
  change theme), moving to a view whose data is not loaded (the shell in 100 ms), and running a query
  (the waiting state in 100 ms). The fixture has no menu, no theme switch and no second view.
  `fixtures/README.md` says `speed.json` measures "every budget row".
- **The author's before/after files are not the shipped scenarios.** `speed/v4-*.json` and `v5-*.json`
  come from `compare-desktop.json` and `compare-phone.json`, which leave out the four "One panel to
  table/chart" rows; the rubric asks for `speed.json` and `speed-phone.json`.
- **No timing row has ever been judged.** The author's eight blocks started at load 10 to 26 on 4 cores
  (calibration 359 to 887 ms); my run at 17.9 to 18.3 (834 ms). That is the harness doing what the rules
  say, and it leaves the Speed row open, neither passed nor failed. What I measured, not judged:

  | `speed-phone.json`, 3 runs, CPU 4x, Fast 4G, load 17.9–18.3 on 4 cores | Budget | p75 | Median | Worst |
  |---|---|---|---|---|
  | Press: Run query (mouse) | 50 | 63 | 21 | 63 |
  | Typing in the query editor | 50 | 37 | 24 | 37 |
  | Crosshair by touch drag, 36 series | 50 | 123 | 46 | 123 |
  | Legend row toggle, 36 / 200 series | 100 | 498 / 298 | 80 / 51 | 498 / 298 |
  | One panel to table, 36 / 200 series | 100 | 496 / 117 | 76 / 116 | 496 / 117 |
  | One panel to chart, 36 series | 100 | 68 | 63 | 68 |
  | Response to paint, 36 / 200 series | 100 | 150 / 40 | 62 / 34 | 150 / 40 |
  | Worst interaction | 200 | 480 | 216 | 480 |
  | Layout shift: load and run; loaded scrolled to each of five charts (judged) | 0.05 | 0.0000 | 0.0000 | 0.0000 |

  Three runs at four times the cores: p75 here is the worst run and means nothing. The medians agree
  with the author's at similar load. "One panel to table, 200 series" has a median of 116 ms over 100
  in all three runs; it is the row to measure first on a quiet machine.

Fix: press by touch on the phone layout; add a menu, a theme switch and a second view to the fixture and
measure them; run the shipped scenarios for before and after; and decide (M4) what a calibration ratio
lets a reviewer conclude, or get a quiet machine for one session.

### M4. The rubric still gives two verdicts in four places

Rubric: System (major). Fixed since v4: Many series asks what a correct chart can answer; budgets live
only under Speed; Touch states the in-sentence exemption and owns the main-path failure; Narrow and zoom
asks for layout shift loaded scrolled to a region; Charts asks the second-channel question. Still two
readings:

1. **Charts: "Can every drawn series be told from every other without hue: by the lightness step and the
   dash of slots 5 to 8".** Two steps times two dash patterns is four kinds of line for eight slots: slots
   1 and 3, 5 and 7, 6 and 8 have luminance ratios of 1.00 to 1.02 in both themes (2 and 4: 1.13 light,
   1.01 dark). One reviewer fails the row from a greyscale image; another passes it on the sentence's
   second half ("and, for a single line, by … emphasis from the legend"). Say which.
2. **Speed and load.** The rubric: a loaded run "is not judged either way; the author measures again".
   The rules: "measured again on a quieter machine **or with the calibration ratio stated**". Is a run
   with its ratio stated judged? The harness records the ratio and uses it for nothing.
3. **Type: "Numbers in `mono`, right-aligned?"** has none of the rules' exceptions (a stat in the sans,
   a mixed-unit column left-aligned, `vz-qty` in prose); read alone, it fails the dashboard's
   `1,284 req/s`.
4. **Tokens: "Does `check.mjs` pass … no literal colours, lengths, …"** makes the tool's pass the
   property; M5 shows the tool passing literal colours, lengths and weights.

### M5. `check.mjs` passes literal values it says it rejects

Rubric: Tokens (the row a pass of this tool answers); AGENTS.md, "Tests must have teeth". 32 mutants of
my own, each applied to a copy by a runner modelled on `mutants.mjs` (the runner lived in the session
scratchpad; every mutant is listed here; nothing was applied in the tree). All
32 were run with the token and lint checks; X1 to X18 were run again with the rendered audit, which
caught none of them; X19 to X32 were not, because the audit measures only text, swatch and line contrast
and none of them changes those. 30 survived.

Inside what `check.mjs` says it checks (header, parts 2 and 4), survived:

| Mutant | Broken |
|---|---|
| X1 | a named colour: `.vz-button { border-color: red }` |
| X2 | `RGB(255,0,0)` (CSS function names are case-insensitive; the lint's are not) |
| X3 | `color-mix(in srgb, var(--blue) 50%, var(--ground))` as a table head's fill: a tinted background, its 50% exempt as "geometry" |
| X4 | `3PX` |
| X5 | `1ex`, `2vmin`, `0.5lh`, `3cqi` (the lint knows px, rem, em, ch, vw, vh, pt, cm, mm, in) |
| X6 | `font-weight: bold` |
| X7 | `@media (max-width: 50em)`: the breakpoint check reads only `px` and the length lint strips conditions |
| X13 | `filter: opacity(0.5)`, `filter: brightness(0.9)` |
| X29 | a single-quoted `style='font-weight:600;width:37%'` in a preview (only double-quoted `style` is read as CSS) |

Outside its stated scope, survived: X8 `border-radius: 50%` (fully rounded); X9 a gradient built from
tokens; X10 a second shadow built from tokens; X11 capitals and tracking on labels; X12 an off-scale
`calc(var(--space-1) * 1.5)`; X14 `linear` and `ease-in-out`; X15 a press that eases; X16 selection in
blue; X17 a series colour on a panel rule; X18 the reduced-motion block removed; **X19 the focus ring
removed everywhere**; **X20 every coarse-pointer hit area removed**; **X21 dashed swatches drawn solid**;
**X22 emphasis removed**; X23 `touch-action` removed (touch drag scrolls the page); X25 `ink-disabled`
equal to `ink-muted`; **X27 the chart reservation ignoring the coarse legend row (v4's B2 back)**; X28 a
main path moved into a sentence; X30 opacity and weight set from script; X31 row actions revealed only
on hover; X32 text below `micro`. Caught: X24 (`series-5` a copy of `series-1`, by the dash-group
check) and X26 (`series-4` near grey, by chroma).

The real CSS contains none of the in-scope literals today (searched), except `1lh` (the agent mark,
the timeline), which is relational. The bold ones are v5's own fixes: each can be undone with
`check.mjs` still green. Fix: lint colours case-insensitively and by keyword, every CSS length unit, any
`em`/`rem` in a condition, keyword weights, `filter`, and `style` in either quote; drop the 50% exemption
inside `color-mix`; and add structural checks for the focus ring, the coarse hit areas, the coarse
reservation, the dashed swatches and emphasis, as v5 did for the swatch ring. Add these mutants to
`mutants.mjs`.

### M6. The dashboard composition's figures disagree with each other

Rubric: Consistency, "do figures shown together agree with each other and with the chart?" (major,
since nobody acts on a composition). Rule: Method, build order 1; `method.md` points to
`reviews/system-v5/` as the worked example. Image `09`.

The slowest-routes table ("last 5 min") gives p99 444 ms for GET /v2/cart/{id} and 141 ms for GET
/v2/products; the latency chart beside it gives their last values as 315 and 117 (444 and 141 are the
chart's 6-hour maxima). The chart says GET /v2/products is `service="checkout-api"`; the table says
catalog. The "Now" stats (Errors 2.41%, p99 912 ms) are POST /v2/orders' row, shown as the dashboard's;
Requests 1,284 req/s is not checkout-api's 1,087 in the request-rate chart. Fix: one sheet of numbers
per composition (the review input `review.md` asks for), checked against every panel.

### M7. The dashboards list hides that it is partial, and its order and ages are wrong

Rubric: Words, "Major: … a result that hides that it is partial". Rules: Words, ages ("the absolute time
beyond a day", "17 Nov, 09:30"). Image `10`.

The dialog composition's list says "12 dashboards, most recently changed first" over three rows, in
which "12 d ago" comes before "3 d ago", and "2 Oct" has no time. Fix: "3 of 12 dashboards, most
recently changed first", in that order, with absolute times.

## Minors

- **m1 A link in a sentence outside a `p` breaks its line.** The coarse rule exempts `p .vz-link` only,
  so a link in a list sentence or in a field's help line (which Field allows) becomes a 44 px
  inline-flex box and opens its line (image `08`: "shows its / other tenants" and "and to its chat /
  channel" 44 px apart). Exempt every link whose block has other text, or `.vz-help .vz-link, li .vz-link`.
- **m2 Key links holding a `vz-cut` have no underline** (image `12`): `text-decoration` does not reach
  inline-flex children, so the long-table's pod links read as bold text while the dialog list's key
  links are underlined. Underline the cut's spans.
- **m3 Error after a result was drawn** (image `11`): 130 px of nothing where the plot was, with
  "Showing the previous query" in the head and coloured swatches for lines that are not drawn. Either
  show the previous plot (inert, as the legend is) or say "Showing the previous query's figures".
- **m4 The done state repeats the page state.** Monitor composition: "Acknowledged by you at 15:16, firing
  since …" in the state line and "Acknowledged by you" again in `vz-done` beside Undo, each with its
  mark, against States, "Nothing else on the page announces it". Let one of them carry it.
- **m5 `series-4` (light) and `series-other` have the same luminance** (1.02:1): in greyscale slot 4 reads
  as the Other band's edge. (v4 m17's `series-8`/Other is fixed.)
- **m6 A threshold inflates the axis**: a 3.5 threshold on data reaching 4.0 sets the top at 6 (`dataMax`
  takes threshold × 1.15, then step 2), a third of the plot empty (image `06`).
- **m7 The reservation needs an inline `style` attribute** (`.vz-chart[style*="--legend-rows"]`); a value
  set from a stylesheet reserves nothing, and the System row asks that no screen need an inline style.
  Key it on an attribute (`data-reserve`).
- **m8 The nav at 400 px** still cuts "Logs" at the edge and puts tenant and Settings out of view (v4 m18).
- **m9 One event, two settings**: the Table preview's "Firing since 13:07, 2 h 9 min" sets 13:07 in the
  sans and the duration in mono, against Type's "one event's 13:07 is set the same way everywhere".
- **m10 The fixture's stat contexts use middle dots** ("last 5 min · 4% below last week") where Words
  allows them only in a panel's meta and a legend name; the compositions use full stops.
- **m11 The time-range help line shows the accepted forms**, not "what they parsed", which Field asks for.
- **m12 `shots.mjs measure`** exempts every link inside a `p` even when it stands alone there, and none in
  a list or help line, so it reports m1 as nothing and would excuse a main path wrapped in its own `p`.
  Classify by the link's block text, as my scan did.
- **m13 The Cover preview** is 561 px wider than a 400 px window (a fixed-size poster); keep it out of the
  overflow audit or let it scale.
- **m14 The scrolling table's right edge never shows.** The wrap carries the 2 px `rule-control` inset
  shadow while there is more to scroll (computed: `rgb(138,138,138) -2px 0 0 0 inset`, its scroll
  animation running), but every cell has its own `ground` fill and the head `sunken`, and an inset
  shadow paints under them: the pixels at the edge are the cells' white (long table, 400 px). Draw the
  edge on the last visible cells' layer or a pseudo-element above them.
- **m15 At 200% zoom the Logs list** (672 px of table, not folded above 640) has its Trace column 6 px
  behind the table's scroll.

## Measured here

**check.mjs** (scratch copy): contrast and structure 589/589, rendered audit 0 failures across 30
previews, 0 literals in `src/components.css`; `project/components` 0, compositions 0, `fixtures` 0. Load 4.8.

**Palette validator** (the dataviz `validate_palette.js`, Machado 2009, `--pairs adjacent` and `all`),
each theme against ground, raised, sunken, hover, rule and pressed: 72 runs.

| Set | Pairs | Light (worst CVD, worst normal) | Dark |
|---|---|---|---|
| Slots 1–8 | adjacent | pass (14.3, 21.1) | pass (9.7, 19.1) |
| Slots 1–4, solid | all | pass (10.6, 21.1) | pass (9.7, 18.7) |
| Slots 5–8, dashed | all | pass (13.9, 21.4) | pass (9.7, 19.1) |
| Slots 1–8 | all | **fail**: 3.3 (`series-6`/`series-4`, deutan), 13.4 (`series-7`/`series-4`) | **fail**: 0.9 (`series-6`/`series-4`), 8.5 (`series-5`/`series-2`) |

The all-eight failures are all between the solid and the dashed group, where Chart rule 1 makes the dash
the channel. The figures the Chart README quotes (light 10.6 and 21.1, dark 9.7 and 18.7) are right. The
validator warns on `pressed` (light `series-2`, `-6`, `-8` at 2.73 to 2.75:1), which the rules hand to the
swatch's ground ring.

**Series contrast, WCAG**, light / dark:

| | ground | raised | sunken | hover | rule | pressed |
|---|---|---|---|---|---|---|
| series-1 | 7.67 / 4.17 | 7.67 / 3.80 | 7.04 / 4.41 | 6.55 / 3.37 | 6.03 / 3.15 | 5.28 / 2.81 |
| series-2 | 3.96 / 5.68 | 3.96 / 5.16 | 3.64 / 6.00 | 3.39 / 4.59 | 3.12 / 4.29 | 2.73 / 3.83 |
| series-3 | 7.73 / 4.15 | 7.73 / 3.78 | 7.09 / 4.39 | 6.60 / 3.35 | 6.08 / 3.14 | 5.32 / 2.80 |
| series-4 | 4.47 / 5.71 | 4.47 / 5.20 | 4.10 / 6.04 | 3.82 / 4.61 | 3.51 / 4.32 | 3.07 / 3.85 |
| series-5 | 7.59 / 4.17 | 7.59 / 3.79 | 6.96 / 4.40 | 6.48 / 3.37 | 5.97 / 3.15 | 5.22 / 2.81 |
| series-6 | 4.00 / 6.11 | 4.00 / 5.56 | 3.67 / 6.46 | 3.42 / 4.94 | 3.15 / 4.62 | 2.75 / 4.12 |
| series-7 | 7.71 / 4.16 | 7.71 / 3.79 | 7.07 / 4.40 | 6.59 / 3.36 | 6.07 / 3.15 | 5.31 / 2.81 |
| series-8 | 4.00 / 5.71 | 4.00 / 5.20 | 3.67 / 6.04 | 3.42 / 4.62 | 3.15 / 4.32 | 2.75 / 3.85 |
| series-other | 4.54 / 4.55 | 4.54 / 4.14 | 4.17 / 4.81 | 3.88 / 3.68 | 3.57 / 3.44 | 3.13 / 3.07 |

Every slot reaches 3:1 on the five surfaces the rules name, in both themes; on `pressed` light slots 2, 6
and 8 and dark slots 1, 3, 5 and 7 are 2.73 to 2.81, as the `pressed` token's note says.

**Greyscale** (luminance ratio): neighbours 1.70 to 1.95 (light) and 1.36 to 1.47 (dark), at least the
1.3 claimed; same-step pairs 1.00 to 1.13 (M4); `series-4` to `series-other` 1.02 light (m5).

**Hit areas, 400 px, coarse pointer and touch** (my scan, eleven pages, 296 controls): none under 44 px,
no overlaps, none covered at its centre (three behind the secret page's scrim excluded). Controls partly
scrolled out of a table's own scroll are not measured but reported: the row actions of B2. Links inside
sentences: one back-link in the report's sub-line (138.6 x 18 px), and in my composition the two of m1.

**Overflow** (page wider than the window): every composition 0 at 400 and 320 px coarse; dialog
composition 38 px at 200% zoom; previews: Table 169 / 249 px at 400 / 320, Cover 561 / 640 / 240 px at
400 / 320 / 200%; reference 177 / 257 px at 400 / 320. Smallest text 11 px (`micro`) everywhere.

**Layout shift**: 0.0000 in all 49 loads of my probe (7 configurations x 7 positions); every chart and
table panel's height the same before and after its data. `speed-phone.json`: 0.0000 in every shift row.

**Keyboard**: my composition, 117 tab stops in each theme, and the Chart preview, 43: every stop has a
ring in the focus colour (legend rows by their cells), none invisible.

**Reduced motion** (reference page): 196 elements with a transition, 0 with reduce. 28 animations remain:
all the table wrap's scroll-linked edge, which follows the scroll position, not the clock.

**Assets**: `dist/viz-chart.js` 52.6 KB (17.6 KB gzip; it carries the demo recipes), `dist/viz.css` 70.8 KB
(16.0 KB gzip), fonts 74.7 KB and 54.1 KB.

## Keep

- The Chart rules' structure and most of their text: slots by rank at first sight, survivors never
  repainted, one Other band with a range and an action row, "Colour the eight largest" as the person's
  own choice, "highest" over everything drawn, the number format, `scaleUnit`, zoom that keeps "now".
- The reserved height built from the same custom properties the coarse block sets: exact at every width.
- Dashes for slots 5 to 8, the lightness stagger and emphasis from the legend.
- The strip above every view as the waiting line's place; Cancel never over data.
- `vz-done`, the menu anchor and bottom sheet, `vz-range`, Waterfall (own time, the bar in ink where the
  time went, failures surviving collapse) and Log (level words, `vz-match`, clamped messages).
- The harness's load and calibration record, and refusing to judge a loaded run.

## The author's claims, checked

(Written after the findings above, from `response.md`.)

**Did not hold:**

| Claim in `response.md` | What I found |
|---|---|
| "How it was checked": every composition has "no sideways overflow at 400, 1440, 1500 px or 200% zoom" | The dialog composition is 38 px wider than the window at 200% zoom (B2, image `05`). Outside the compositions, the Table preview and `dist/reference.html`, which the response says was "rebuilt but not re-imaged", scroll 169 and 177 px at 400 px. |
| M2: "The chart specification is closed" | Rules 4 and 5 disagree (B1); values below zero, "which series are above it", the precision at a 2.5 step and unsaved series in a panel's map are open (M2). |
| B1, "Beyond the review's fix": a filter that removes every coloured series is covered by the note and "Colour the eight largest" | The button is there; the note then says "36 in Other are now larger than a coloured series" when nothing is coloured (image `02`). And the case arises without any filter removing them, from a query edited and edited back. |
| M6: "The only `style` attributes left in previews are the chart's documented `--legend-rows` and `--legend-notes`" | The Waterfall preview has 13 `style="--at: …; --len: …"` attributes (the response defends them under "Disagreements", so the two sections contradict each other), and the Chart preview's script writes `style="width:…px"` on the legend's columns. The "0 literal values in 29 files" is now 0 in 31. |
| m8: "A `rule-control` edge at the right while there is more to scroll" | Computed and running, but painted under the cells' own fills, so it never shows (m14). |
| M3: "`shots.mjs` now measures links inside sentences and lists them" | Only links inside a `p`. A link in a list sentence or a help line is measured as a control, and passes at 44 px because of m1, the bug that breaks its line. |
| `fixtures/README.md`: `speed.json` measures "every budget row" | Three of the six rows have no measurement (M3). |

**Held, checked here:** the v4 round trip returns slots 1 to 3 and "highest" covers Other (B1's v4
case); reserved height equals drawn height and layout shift is 0.0000 on a phone loaded scrolled to
every chart (I did not record the pixel heights; no panel's height changed when its data arrived, in 49
loads); every validator figure in the M1 table and the luminance steps (1.70 to 1.95, 1.36 to 1.47);
the contrast ranges on the five named surfaces (light 3.12 to 7.73, dark 3.14 to 6.46) and the `pressed`
exceptions (2.73 to 2.81); 0 controls under 44 px, covered or overlapped at 400 px coarse, and the one
back-link in a sentence; the legend row's ring drawn round the whole row (keyboard walk); reduced motion
removes every transition; `check.mjs` 589/589 with 0 rendered failures and 0 literals; previews and
compositions lint clean; 14 of the 31 mutants in `mutants.mjs` (R7, R9, R12 to R17, N2, N3, N5 to N7,
N13) re-run here on a copy without the rendered audit, all caught with the same first line (the other
17, seven of which need the audit, were not re-run, for time); the speed files' loads and calibration times are as
stated, and every timing row in them is correctly "not judged"; `vz-done`, the menu anchor and sheet,
`vz-range`, `vz-row-actions`, Section, Waterfall and Log exist and render in both themes; the 2.5-step
ticks ("7.5").

Not checked: the claim that `assignSeries` was taken verbatim from v4 for the comparison, the reserved
heights in pixels, the counterfactual draw timings under "Response to paint", and anything about
`flows/`.

## Housekeeping

Built, rendered, mutated and measured on a copy of `design-system/` in the session scratchpad; the tree
was not edited except for this file and `review-images/` (16 images, 2.9 MB). One static server
(port 8931, on the copy) and the harness's own server ran during the review and are stopped. No git
command was run. No Cloudflare resource was touched.
