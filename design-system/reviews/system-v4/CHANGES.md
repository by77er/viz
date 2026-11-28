# Design system v4: what changed, why, and how to migrate

The inputs were `reviews/app-restyle/review.md` ("Changes the design system needs", M1, M2,
M4 to M8), `reviews/app-restyle/PR.md` ("Proposed system changes", all agreed by the reviewer)
and `reviews/flows-v1/review.md` ("System changes these screens need", B1, B2, B5, M2 to M6,
M10). Finding ids below are written `AR-M2` (app-restyle review), `AR-PR3` (app-restyle PR,
proposed system change 3), `AR-S5` (app-restyle review, "Changes the design system needs" item 5),
`FL-B1` (flows-v1 finding) and `FL-S4` (flows-v1, "System changes these screens need" item 4).

Status: **not reviewed.** It needs an independent review under `project/review.md` before the
app or the screens are moved onto it. Nothing outside `design-system/` was edited, and git was
not run, so "before" values come from the reviews and from `reviews/system-v3/`, not from a diff.

## How this revision was done

The work was started by one engineer and finished by a second after a usage limit. At the
hand-over, judged against the approved v3 state and by building, checking and rendering:

| Part | At hand-over | Finished here |
|---|---|---|
| A. Chart | Largely written (README, reference chart, colour rule, re-stepped light palette, `series-other`), never rendered. Rendering found: legend names measured before the web font loaded (dark legend cut mid-word, "checkout-ap"); readout cut at 400px; interval label placed outside its span at 400px; marker lines drawn over the words on the plot; the legend note claiming "the 8 highest in this range" after a zoom or filter made that untrue; validator results not recorded. | All fixed and re-rendered; validator run and recorded below. |
| B. Touch and density | CSS written (touch links and rows, `vz-controls`, `data-fold`, `vz-query` and mono inputs on touch, toned-button separation), never measured. Rendering found: threshold cells splitting a quantity across lines ("5 /h for 1 / h"); folded heads off one line; two Cancel buttons in the Progress preview 43px apart. | Fixed; every composition and the 400px reference measure 0 hit areas under 44px. |
| C. States | CSS written for press over hover, busy without easing, pressed legend rows, sort heads, menu rows, checked menu row, scrim, closed dialog, failure notice, age wording. Rendering and measuring found: the press fill (`rule`) was 1.09:1 against hover in light and 1.07:1 in dark, so a press was barely visible; `vz-scrim` let a dialog grow past a 400px screen (the secret dialog's Copy and Done were off screen); the waiting line covered the chart's unit and top tick. | New `pressed` token; scrim column fixed; waiting line moved to a strip that holds no data. |
| D. Inline number | `vz-qty` written; its README cited an image of the candidates that did not exist. | Five candidates rendered and measured; `vz-qty` also made its line 2px taller, fixed. |
| E. New components | All present with README and preview: PageHeader, KeyValue, Timeline, Claim, Changes, Secret, Notice, FirstRun, Controls, Number, sortable head, checked menu row, disposition marks; `status-info` a cyan. | Verified in both themes at 1440 and 400px; Table gained a caption. |
| F. Tools | `shots.mjs` scenarios, `speed.mjs`, the fixture and `check.mjs` pairings written; `speed.mjs` never run. The scenario's reference states pictured the light column for both themes; hit-area outlines were capped at 120px wide. | Harness run (20 runs, below); `shots.mjs` and `check.mjs` extended; scenarios fixed. |
| G. Rubric and rules | Not started: rules, method, rubric and the system README were at v3. | Written. |

Three look-and-fix rounds were rendered (`shots.mjs scenario`, both themes, 1440 and 400px,
coarse pointer, 200% zoom, greyscale, pressed, hover, focus); every image was looked at.

## Tokens

| Token | Before (v3) | After (v4) | Finding |
|---|---|---|---|
| `series-2` light | `#eb6834` (3.20:1 on white, 2.94 on sunken) | `#e76530` (3.33, 3.06) | AR-S3 |
| `series-3` light | `#1baf7a` (2.82:1) | `#25a071` (3.31) | AR-S3, FL-B5 |
| `series-4` light | `#eda100` (2.17:1) | `#bf8100` (3.30) | AR-S3 |
| `series-5` light | `#e87ba4` (2.69:1) | `#d56a93` (3.33) | AR-S3 |
| `series-1`, 6, 7, 8 light; all dark | | unchanged | |
| `series-other` | none | `#808080` / `#7a7a7a` | AR-M2, AR-S2 |
| `status-info` | light equal to `blue`, `#1257ff` (FL minor); dark value not recorded in the reviews | `#0b7a99` / `#45b8d8` (a cyan) | FL-S5 |
| `scrim` | none | `rgba(17,17,17,0.40)` / `rgba(0,0,0,0.64)` | AR-PR (scrim), AR-m9, v3 follow-up |
| `pressed` | none (presses used `rule`: `#e4e4e4` / `#2b2b2b`) | `#d6d6d6` / `#333333` | AR-M6, measured here |
| `yellow-edge` | none (the yellow button's edge was 1.41:1) | `#8f7600` / `#ffd60a` | FL minor, FL-S5 |
| `plot`, `plot-sm` | none (the app used `calc(var(--row) * 10)`) | `200px`, `120px` | FL-S4 |
| `axis`, `label-gutter` | none | `44px`, `136px` | AR-M1, FL-S4 |
| `keep` | none | `26%` (width of a kept column in a folded table) | FL-S2 |
| `rule` usage | hairlines | hairlines and the fill of what is chosen | |

`pressed` against its neighbours: light 1.24:1 against hover and 1.14:1 against rule (the old
press, `rule`, was 1.09:1 against hover and identical to a chosen item), dark 1.20:1 and 1.12:1
(was 1.07:1). Ink on it 12.99:1 light and 11.29:1 dark, ink-secondary 6.39:1 and 6.37:1, the
focus ring 3.77:1 and 4.04:1. `ink-muted` is 3.67:1 and 3.91:1 on it, so muted text switches to
`ink-secondary` on a pressed row.

## Series colour: the decision and the validator

**Rule** (Chart README, "Series colour"; AR-M2, AR-S1, AR-S2, FL-S4). The two demands
conflict once a filter changes: "fixed order" wants slot 1 for whatever comes first, "colour
belongs to the entity" wants a series never to be repainted. Resolved as: a view owns a map
from series to slot; series new to the view take the lowest free slots in palette order, by
rank (highest value in the window when first seen, ties by name), so on first load the
largest is `series-1` and the eight coloured are the eight largest; survivors are never
repainted through filters, sorts, range changes or new queries in the same view; a slot whose
series left stays reserved until a new series needs it; more than eight are one "Other"
(`series-other` edges, `sunken` band from lowest to highest, one legend row with ranges,
expandable 20 at a time; a picked member draws in `ink`); never a sum except in a stack.
**Life of the view**: an Explore tab keeps its map for the tab's session (survives reloads,
gone when the tab closes); a dashboard panel stores its map with the panel, so every viewer and
reload sees the same colours; a shared link carries the ordered list of up to eight series
keys, so the recipient sees the sender's colours. Rejected: hashing labels to slots (the app's
first version; collisions repaint, the order is not fixed, AR-M2), and colouring by sort order
(the largest series was grey).

**Re-step.** The light slots 3, 4 and 5 were stepped down in lightness, holding hue, until
each reached 3:1 on `ground`, `raised` and `sunken`; slot 2 moved with them because it was
2.94:1 on `sunken` (the Other band and intervals). Rendered: `alternatives/series-palette.png`.
The validator (`dataviz/scripts/validate_palette.js`, Machado 2009 simulation) was run on each
set:

```
BEFORE light, --surface "#ffffff":  #2a78d6,#eb6834,#1baf7a,#eda100,#e87ba4,#008300,#6250d6,#e34948
  [PASS] Lightness band         all 8 inside L 0.43–0.77
  [PASS] Chroma floor           all 8 >= 0.1
  [PASS] CVD separation         worst adjacent #eda100↔#1baf7a ΔE 9.1 (protan) · tritan 5.8
  [PASS] Normal-vision floor    worst adjacent #e87ba4↔#eda100 ΔE 19.6 (normal)
  [WARN] Contrast vs surface    below 3:1 — relief required: [["#1baf7a",2.82],["#eda100",2.17],["#e87ba4",2.69]]

AFTER light, --surface "#ffffff":   #2a78d6,#e76530,#25a071,#bf8100,#d56a93,#008300,#6250d6,#e34948
  [PASS] Lightness band         all 8 inside L 0.43–0.77
  [PASS] Chroma floor           all 8 >= 0.1
  [PASS] CVD separation         worst adjacent #bf8100↔#25a071 ΔE 9.0 (protan) · tritan 4.7
  [PASS] Normal-vision floor    worst adjacent #d56a93↔#bf8100 ΔE 17.5 (normal)
  [PASS] Contrast vs surface    all 8 >= 3:1
  (the same against --surface "#f5f5f5", sunken: all PASS)

DARK (unchanged), --surface "#121212": #3987e5,#d95926,#199e70,#c98500,#d55181,#0ca30c,#9085e9,#e66767
  [PASS] Lightness band         all 8 inside L 0.48–0.67
  [PASS] Chroma floor           all 8 >= 0.1
  [PASS] CVD separation         worst adjacent #c98500↔#199e70 ΔE 8.4 (protan) · tritan 8.7
  [PASS] Normal-vision floor    worst adjacent #d55181↔#c98500 ΔE 19.3 (normal)
  [PASS] Contrast vs surface    all 8 >= 3:1
  (the same against --surface "#1c1c1c", raised: all PASS)
```

Every slot meets both 3:1 and the validator, so **no slot needs a mandatory dash or marker**.
The second channel is position and words (direct labels, the legend sorted to match the right
edge, choosing rows); dashes stay reserved for thresholds. Cost of the re-step: the worst
normal-vision pair fell from 19.6 to 17.5 (floor 15) and the tritan figure for slots 3 and 4
from 5.8 to 4.7 (reported, not gated).

**Not on hover.** Light slots 2 to 5 are 2.82 to 2.85:1 on `hover` and 2.60 to 2.62 on `rule`.
AR-S3 asked for "series on ground, hover and raised" in `check.mjs`. Instead series are never
drawn on those fills: the legend swatch and the crosshair dot carry a `ground` edge, and
`check.mjs` now fails if either edge is removed from the CSS. Stepping the four slots down
further to clear 3:1 on hover would cost lightness band and normal-vision separation for no
reader benefit, since nothing coloured touches hover.

## Components and rules, by finding

Chart (new as a component; Chart README and preview, `dist/viz-chart.js`)

- Direct labels in a right gutter at each line's last value with a leader tick, stacked apart
  by label height; none at all if any label would be more than two label heights from its own
  line, beyond eight series, below 640px of chart width, or in a small chart. AR-M1, AR-S7, FL-M6.
- Labels and legend names fitted by measured text, re-measured when a web font arrives (bug found here).
- Axes: three to five round ticks, bare numbers on one scale, a tick on the threshold, the unit
  once at the top of the axis; the time axis's ends are the range's ends, both labelled; step
  and aggregate in the panel meta; gaps are gaps. AR-M7, AR-S10, FL-M6.
- Thresholds labelled in words; intervals shaded and labelled inside their span (fixed here);
  deploy and other markers with their word beside their own line (fixed here); every word on
  top of every line (fixed here). FL-B4, FL-M6, FL-S4.
- Readout under the plot, never over it; the legend's Last column becomes "At 13:02"; on a
  narrow chart the readout takes its own line, decided by width, and its name is cut in the
  middle (fixed here). Arrow keys, Home, End, Escape, plus and minus; touch drag moves the
  crosshair; "Zoom in" and "Zoom out" buttons. AR-M4, AR-S8.
- Legend as a table (Last, Min, Max; Min and Max drop below 640px), sortable heads, chosen rows
  (`aria-selected`) and switched-off rows (`data-off`), a tap toggles with no modifier key, one
  tab stop with arrow keys. AR-M4, AR-M5, AR-m7.
- Names: labels shared by all series are dropped and stated once; the rest are ordered by how
  many distinct values they take; every row shows the same labels, dropping the least
  distinguishing from all rows until all fit; one value still too wide is cut in the middle.
  The algorithm is `fit` and `distinguish` in the preview. AR-M5.
- One number format per chart (ticks, legend, readout). AR-M7. Fixed text sizes; drawn at the
  region's size, never scaled.
- Plot strip: the `space-6` strip above the plot holds the unit and marker words and is where a
  waiting line lies (decided here, below).

Touch and density

- `.vz-link` standing alone is `control-touch` tall; inside a `p` it stays text. Table rows,
  legend rows, menu rows and checkboxes are `control-touch` tall on a coarse pointer; a key
  link fills its cell. FL-B1, FL-S1.
- `vz-controls` (wrapping rows, `space-3` row gap, touch row gap `control-touch` minus
  `control-sm`, `space-6` between two toned buttons) and `vz-stack`. FL-B2, FL-S3, FL-M2, v3 minor.
- `vz-query` and `.vz-input[data-mono]` are `control-touch` tall with `body`-size text on a
  coarse pointer; an editor inside the well inherits it. AR-B2, AR-S6, AR-PR2.
- **Narrow table: fold, not expander.** `data-fold` with `data-priority="1"` keeps the key and
  one or two columns the list exists for, and folds the rest into a second line under the key,
  each with its `data-label`. Rendered against the scroll form and a row expander
  (`alternatives/narrow-table.png`): scroll hides Now and Threshold behind a sideways drag
  (FL-M10); the expander shows them only after a tap per row, which is the wrong cost for
  someone scanning a list at night; fold shows every value with no interaction, at the cost of
  taller rows. Kept quantities are `vz-qty`, so a narrow column wraps between quantities
  (fixed here). Shown on Monitors at 400px keeping Now and Threshold
  (`images/monitors-400-coarse-light.png`). FL-M10, FL-S2.
- Nav gutter `space-4` below 640px. AR-PR4.

States

- `:active` after `[data-quiet]:hover`, so a quiet button shows its press. AR-S4.
- `[aria-busy]` takes the pressed fill with `transition-duration: 0s`. AR-S5.
- Pressed for legend rows, sortable heads, menu rows, quiet buttons, links and a key link's
  cell, now in the new `pressed` fill (`images/states-controls.png`, `images/states-rows.png`). AR-M6.
- Checked menu row: `menuitemradio`/`menuitemcheckbox` with `aria-checked`, a reserved tick
  column, `ui-strong`; button rows reset. AR-PR3, AR-PR (checked menu row).
- Dialog: `scrim` on `::backdrop` or a `vz-scrim` wrapper, which now centres the dialog in one
  screen-wide column (fixed here); a closed `<dialog>` stays hidden. AR-PR1, AR-m9.
- **Waiting line.** Chosen: it lies over the view's top strip, which holds words about the data
  and never the data (a chart's marker words, right of the value axis; a table's new
  `vz-table-caption`, count and order). Rejected, both rendered: over the body's top edge
  (hid the unit "req/s" and the top tick, `alternatives/waiting-line.png`); and a reserved
  empty line (AR-M8: it answers nothing when idle). AR-PR6, AR-S9.
- "Chrome describing data belongs to the data on screen": rule in the rules file, Panel and the
  rubric; `vz-panel-note` "Showing the previous query" while another query waits and after a
  cancel or failure. AR-B1.
- Age wording: "just now" under 5 s, seconds, minutes, hours, the absolute time beyond a day.
  AR-m3, AR-PR9.
- Failure notice (`vz-notice`): at the control that started the action, floating only if that
  control is gone; stays until dismissed or retried. v3 follow-up.

Inline number (Number README; `vz-qty`). FL minor ("20  s"), FL-S6, AR-PR (inline `vz-num`).
Five candidates rendered and measured (`alternatives/inline-number.png`), gap before the unit
and height of a one-line sentence at `ui` (its own line 20px):

| Candidate | Gap | Line | Verdict |
|---|---|---|---|
| A. `vz-num` inline (v3) | 7.8px | 21px | the double gap the review found |
| B. Sans with tabular figures | 3.6px | 20px | stretches "2 . 41", "1 , 284", "13 : 07" |
| C. Mono digits, sans unit | 3.6px | 21px | two faces in one quantity |
| D. Mono with a typed U+202F | 3.9px | 21px | works only if every author types the character |
| E. `vz-qty`: mono, ordinary space tightened by `space-1`, no-break, line-height 1 | 3.8px | 20px (18px at `small`) | chosen |

Units: space before a unit, none before "%" or a bare per-period unit ("7/h"); "min", never
"m"; at most two parts; one scale and precision per column; mixed-unit columns left-aligned
with each cell's unit (FL-S9).

New components, each with README, preview and states: PageHeader (wrap rule: actions drop below
the title as one row), KeyValue, Timeline, Claim (provenance line, "Not verified" until a person
confirms, evidence query and "Open the query in Explore", a `stroke` left rule nothing else
uses), Changes (per-change checkbox, before and after, "Apply 2 changes"), Secret (masked,
Reveal, Copy key with "Copied", "I have saved the key" gating Done, no Escape), Notice, FirstRun,
the sortable head, the checked menu row, and the disposition marks: acknowledged (half-filled
square), silenced (two bars), ruled out (a slash), neutral, shape plus word. FL-S7, FL-S8,
FL-M1, FL-M2, FL-M4, FL-M5, FL-M9. `status-info` separated from blue. FL minor, FL-S5.

Rules (`project/README.md`), method (`project/method.md`), rubric (`project/review.md`)

- Rules: `pressed` and `rule` roles; disposition marks; the Charts rule rewritten; inline numbers
  and the mixed-unit exception; `vz-controls`; states for small controls and busy; chrome
  belongs to the data on screen; budgets measured with `speed.mjs` on the fixture including 36
  and 200 series, typing key by key; where the waiting line goes; every touch exception; touch
  parity; the fold; ages; one time per event; agent text marked; the page head. Principles
  renumbered 1 to 6 (v3 minor).
- Method: one fixture clock and one set of numbers per flow; states for every control; the
  many-series and one-series cases; a touch-and-narrow step; consistency and stale-label checks;
  "Compose before judging" with this folder as the example.
- Rubric (verdict definitions unchanged): Speed now names typing and the 36- and 200-series
  cases; new rows Stale data, Consistency, Agent content, Touch parity, Many series; the Charts
  row covers step, range end, labelled thresholds and labels on the right lines; the author
  provides p75 and worst runs and, for a flow, the review input.

Tools

- `shots.mjs`: scenarios (hover, press held, focus with the ring, click, tap, type, key, wait N
  ms, scroll, eval; coarse pointer, zoom, greyscale, reduced motion, clip). Added here: measured
  hit areas up to 480px wide so outlines are true, items cut by a scrolling strip listed
  separately instead of reported as small, and sans text in tabular figures counted.
- `speed.mjs`: N runs, 4x CPU, Fast 4G, p75, median and worst for press, typing in a named
  editor, crosshair, a named toggle, response to paint, layout shift and the worst interaction.
  First run here (below).
- `fixtures/`: `dashboard.json`, a seeded generator (the reference chart's own recipes; 3, 8, 36
  and 200 series, a backtest, a table), `build.mjs` and `speed.json`. Deterministic: two runs of
  `node fixtures/generate.mjs pods-all` hash identically, and the built `pods.json` equals the
  generator's output.
- `check.mjs`: series on ground, raised and sunken; `series-other`; neighbouring series apart;
  `status-info` not `blue`; disposition and marker pairings; added here: ink and ink-secondary
  and the ring on `pressed`, press against hover and against rule, and the swatch's and dot's
  ground edge. Mutants: removing the swatch edge, setting `pressed` to `hover`, and putting
  `series-4` back to `#eda100` each fail the check (1, 4 and 3 failures); restored.

## What was rendered and measured

`node tools/check.mjs`: **contrast 240/240 pairings pass; literal values 0** in
`src/components.css`.

Compositions (`compositions/*.html`, scenario `shots.json` and `states.json`; images in
`images/`): Monitors at 1440 and 400px (folded table, coarse, outlined hit areas, 200% zoom,
greyscale, pressed sort head); Monitor; charts with 3, 8, 36 and 200 series at 1440 and 400px,
light and dark, greyscale, 200% zoom, keyboard crosshair, 200-series crosshair, chosen rows,
Other opened with members picked, sorted and zoomed, touch crosshair at 400px; Explore waiting
on the previous query; a dialog on its scrim; an agent claim list; the secret-once flow
revealed, copied and saved at 400px; a first-run page; every control's rest, hover, pressed and
focus; the sticky first column scrolled and hovered at 400px; `reference-v4.png` (1500px, 2x).

| Measured | Result |
|---|---|
| Sideways overflow at 400px and 200% zoom, every composition and the reference | 0px |
| Hit areas under 44px or overlapped, coarse pointer, 400px | 0 of 187 on the reference; 0 in every composition (3 to 52 each). Items cut by a scrolling strip, reachable by scrolling: the nav's last items and a wide table's last heads |
| Smallest text | 11px (`micro`, chart axes) |
| Sans text in tabular figures | 0 elements |
| Sticky first column | covers what scrolls under it, keeps its hairline and the hover fill, both themes |
| Checkbox | ink box with a ground tick, both themes |
| Contrast | 240 pairings, both themes, all pass |

Speed, `node tools/speed.mjs fixtures/speed.json`, measured here on the system's fixture page
(a floor, not the application), 20 runs, CPU 4x, Fast 4G, 1440x900, on a shared machine with
a load average of 12 to 14:

| What | Budget | p75 | Median | Worst | |
|---|---|---|---|---|---|
| Press: Run query | 50 ms | 23 | 18 | 48 | within |
| Typing in the query editor | 50 ms | 37 | 23 | 66 | within |
| Crosshair, 3 series | 50 ms | 38 | 31 | 44 | within |
| Crosshair, 36 series | 50 ms | 50 | 35 | 74 | within, at the limit |
| Crosshair, 200 series | 50 ms | 37 | 31 | 88 | within |
| Charts to tables, seven panels | 100 ms | 108 | 96 | 206 | **over** |
| Tables to charts | 100 ms | 60 | 54 | 250 | within |
| Legend row toggle, 36 series | 100 ms | 131 | 80 | 236 | **over** |
| Response to paint, 36 series | 100 ms | 64 | 39 | 118 | within |
| Response to paint, 200 series | 100 ms | 29 | 16 | 51 | within |
| Layout shift, load and run | 0.05 | 0.0004 | | | within |
| Worst interaction | 200 ms | 168 | 136 | 224 | within |

Profiled once with 4x CPU and no other load in the page: a legend toggle is about 25 to 30 ms of
script (the whole chart and legend are rebuilt), 8 ms of layout and 15 ms to the frame; the
charts-to-tables switch is 12 ms of script and 50 ms of layout for seven tables. Text
measurement is now memoised (one `measureText` per string), which did not bring the toggle under
budget on this machine. The two over-budget rows are open.

## What was not done, and why

- **No independent review.** The process needs a reviewer who did not write this.
- **Two budgets over on the fixture** (above). Fixing them means drawing only what a toggle
  changes, and containing table layout; not attempted in this revision. The application has not
  been measured against the fixture at all.
- **Series not stepped to 3:1 on hover** (see the colour section): guarded by the ground edge.
- **`reference-v4.png` is 1.6 MB**, above the ~500 KB guide: one 2x image of every component in
  both themes is 3000 x 19312 px. It is palette-encoded with every token colour kept exact. The
  other images are 4 to 175 KB.
- **No alternatives rendered for the disposition shapes** or for the claim's left rule; they
  were chosen by the first engineer and checked here only in greyscale and both themes.
- Stacked charts and pinch zoom are not in the reference chart (buttons replace pinch).
- Not checked: real touch hardware, a screen reader by ear, Safari and Firefox, enlarged text
  as distinct from zoom.
- v3 minors still open: the select arrow drawn with gradients; `optimizeLegibility` and
  `antialiased`; untoned buttons at weight 600; the tab focus ring close to the letters;
  `space-12` and `radius-0` unused.
- `app/` and `flows/` were not edited (out of scope); see the migration notes.

## Migration notes: `app/src`

1. `app.css`: delete `dialog:not([open]) { display: none; }` and `dialog::backdrop { background:
   transparent; }`; the system hides closed dialogs and paints `scrim` on `.vz-dialog::backdrop`.
   Give `dialog.palette` the same backdrop: `dialog.palette::backdrop { background: var(--scrim); }`.
2. `app.css`: delete the coarse-pointer workaround for `.vz-input[data-mono]` at the end, the
   `.region .vz-empty { padding-top: 0 }` rule, `.vz-menu button[role="menuitem"]` resets, and
   the `.app-nav` gutter override in the 639px container query (the system does all four).
3. `.app-num` → `<span class="vz-qty">` around each number with its unit in a sentence
   ("updated <span class="vz-qty">12 s</span> ago"); delete `.app-num`.
4. `.th-button` → `<button class="vz-sort">` inside `<th aria-sort="…">` (`Legend.tsx`,
   `ResultTable.tsx`); delete `.th-button` rules including the coarse ones.
5. Legend (`Legend.tsx`): `<table class="vz-table vz-legend-table">`; each row's first cell holds
   `<button class="vz-series"><span class="vz-swatch" data-series="1…8|other|picked"></span>
   <span class="vz-series-name">…</span><span class="vz-series-rest">…</span></button>`;
   chosen rows `aria-selected="true"`, the others `data-off` while any are chosen; one row
   "Other" with "28 series" and ranges ("0.0 to 1.5") in Last, Min, Max, expanding 20 at a
   time. Delete `.series-toggle`, `.swatch`, the `.legend-table td` coarse rule and the Shift
   hint. A tap toggles a row on every pointer.
6. Colour (`lib/assign.ts`, `lib/color.ts`): rank by the maximum over the window when a series
   first appears (not the mean); keep the map per view in `sessionStorage` and put the ordered
   list of up to eight keys in the shared URL; `slotToken(null)` returns `--series-other`, not
   `--ink-muted`; draw Other as one band (`--sunken` fill, `--series-other` edges), not as
   hairlines and not as a list only.
7. Chart (`TimeSeriesChart.tsx`): direct labels in a right gutter of `--label-gutter` with
   `--ink-muted` leader ticks, stacked, none below 640px or if any would sit more than two label
   heights from its line; a `--axis` value gutter; a `space-6` strip above the plot with the
   unit; time-axis ends labelled with the range's ends. Replace the floating `.chart-tip` with a
   `div.vz-chart-foot` under the plot (readout left, `vz-controls` with "Zoom in" and "Zoom out"
   right) and the legend's Last head "At 13:02". Crosshair a solid `--ink` hairline (not the
   dashed `.u-hz .u-cursor-x`); brush `.u-select` filled `--sunken` with `--ink` edges. The
   reference implementation to copy rules from is `dist/viz-chart.js`.
8. `TimeRangePicker.tsx`: add "Zoom in" beside "Zoom out", both `data-size="sm"` (AR-M4, AR-M8).
9. Waiting (`ExplorePage.tsx`, `waiting.tsx`): render `vz-progress` as the first child of a
   `div.vz-panel-body` that also holds the chart; delete `.wait-slot` and its reserved line.
   Derive unit, format, chart name and digest title from the result's own query, and while it
   differs from the typed one put `<span class="vz-panel-note">Showing the previous query</span>`
   first in `vz-panel-meta` (AR-B1). The table form gets a `p.vz-table-caption` above it.
10. Ages (`lib/time.ts`): "just now" under 5 s, then "12 s ago", "14 min ago", "3 h ago", and
    "17 Nov, 09:30" beyond a day; "min" for minutes everywhere ("15 min", "auto, 15 s").
11. Units (`lib/units.ts`): unit once in the column head ("Last, req/s"), bare cells, one
    precision for ticks, legend and readout; binary-round byte ticks.
12. Presses: any app `:active` fill on `var(--rule)` becomes `var(--pressed)`. CodeMirror's
    selection and bracket match on `--rule` stay (they are not presses).
13. Menus: the active time preset becomes `role="menuitemradio" aria-checked="true"` (drop the
    `aria-current` rule in `app.css`).
14. Skip link: `.app-skip` → `<a class="vz-button vz-skip" href="#main">`.
15. Measure with `tools/speed.mjs`: serve the fixture's panels and data under `/fixture` and
    run `fixtures/speed.json` with the app's selectors, typing included, then the 36-series case.

## Migration notes: the flow screens (`flows/screens/*.html`, `flows/build.mjs`)

1. `build.mjs` CSS: replace `.head` with `header.vz-page-head` (`h1.vz-page-title`,
   `p.vz-page-state` for a state, `p.vz-page-sub`), `.sub` with `vz-page-sub`, `.row` with
   `vz-controls`, `.stack` with `vz-stack`, `.two` with `vz-split`, `.kv` with `dl.vz-kv`,
   `h2.sec` with `vz-section-title`; wrap each page in `main.vz-page`; delete the literal
   `@media (max-width:800px)` rule (`vz-split` and `vz-diff` fold by container width).
2. Charts: replace the `line()` SVG function with `dist/viz-chart.js` (`vzChart(el, spec)` on a
   `div.vz-chart` inside `div.vz-panel-body`); each spec gives `unit`, `agg`, `t0`, `step`,
   `threshold: { value, label: "500 ms objective" }`, `spans` and `markers` (13:02 above, 13:07
   fired, 09:41 deploy). Put "09:16 to 15:16 · 6 min max" in the meta. Backtest (screen 5):
   `data-size="sm"`, spans "14 min" and "31 min", series near 0.4% (FL-B4).
3. Fixture clock 15:16 on 18 Nov 2026 and one set of numbers on every screen (FL-B3, FL-M7);
   write them into `REVIEW-INPUT.md`.
4. Monitors (3): `table.vz-table[data-fold][role=table]` with roles on rows, heads and cells;
   `data-priority="1"` on Now and Threshold; `data-label` on folded cells; each quantity a
   `vz-qty` ("&gt; <span class="vz-qty">500 ms</span> for <span class="vz-qty">5 min</span>");
   Now and Threshold are mixed-unit columns, left-aligned. `compositions/monitors.html` is a
   worked copy.
5. Dispositions: acknowledged `vz-status[data-state="ack"]`, silenced `data-state="silenced"`,
   ruled out `data-state="ruled-out"` with the word "Ruled out", never the unknown dash.
6. Monitor (4): `vz-page-state` "Firing since 13:07 (2 h 9 min)" with the critical mark;
   Acknowledge (green) and "Silence…" (default) in `vz-controls`, Silence opening a `vz-menu` of
   `menuitemradio` rows (15 min, 1 h, 4 h, Until resolved); History as `ol.vz-timeline`; a
   failed action as `vz-notice` under its control; Related as `ul.vz-links`.
   `compositions/monitor.html` is a worked copy.
7. Investigation (6): each claim an `article.vz-claim` with `p.vz-claim-by` ("Agent's claim ·
   confidence high ·" and a `vz-status` "Not verified"), `p.vz-claim-text` with only the subject
   in `b`, `div.vz-claim-evidence` with its `vz-query` and "Open the query in Explore", and
   "Confirm claim" / "Reject claim" small buttons; agent sentences elsewhere (Monitor banner,
   History) take `vz-agent` and start "Agent:". The chart beside the report shows the agent's
   range, "as the agent read it", with a link to see it now. `compositions/claims.html`.
8. Proposed change (7): `ul.vz-changes` of `li.vz-change`, each with a `vz-check` labelled with
   the sign, verb and thing, `p.vz-change-why`, `div.vz-diff` (Before, After), and a warning
   help line; "Apply 2 changes" with the revision sentence.
9. Keys (8): the shown-once moment as `vz-secret` inside a `dialog.vz-dialog` opened with
   `showModal()` (or a `vz-scrim` wrapper): masked "viz_••••4f2a", Reveal, Copy key, the warn
   help line, "I have saved the key" gating Done, "Discard this key". Elsewhere keys are cut in
   the middle: "viz_k7…4f2a". `compositions/secret.html`.
10. Every number with a unit in prose is `vz-qty`, not `vz-num`; ages per the Number table;
    "min" for minutes; counts in words ("5.76 billion").
11. Dashboards (1) and Monitors with nothing yet: `div.vz-start` with `vz-steps`.
12. A panel that has stopped updating, or shows a previous query, says so with `vz-panel-note`;
    a table inside a panel starts with `p.vz-table-caption`.
13. Stat context starts with its window ("last 5 min · …"); a `vz-select` with one option
    becomes text; a banner may hold one link instead of a button.
14. Capture states with `tools/shots.mjs scenario` (focus per screen, the states FL-B6 lists).

## Files

- Tokens and CSS: `project/tokens.json`, `src/components.css` (generated `bundle.css`, `dist/`).
- Rules: `project/README.md`, `project/method.md`, `project/review.md`; `README.md`.
- Components: every `project/components/*/README.md` and `preview.html` touched by the list above.
- Tools: `tools/check.mjs`, `tools/shots.mjs`, `tools/speed.mjs`, `tools/reference.mjs`, `fixtures/`.
- This folder: `compositions/` (the HTML), `shots.json` and `states.json` (scenarios),
  `images/` (51 renders), `alternatives/` (four decisions, each HTML and PNG),
  `reference-v4.png`. Images were palette-encoded with every token colour kept exact.

Reproduce: `node tools/build.mjs && node tools/reference.mjs && node fixtures/build.mjs && node
tools/check.mjs && node tools/shots.mjs scenario reviews/system-v4/shots.json <out> && node
tools/shots.mjs scenario reviews/system-v4/states.json <out> && node tools/speed.mjs
fixtures/speed.json`.
