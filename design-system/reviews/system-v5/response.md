# Design system v5: response to the v4 review

The input is `reviews/system-v4/review.md` (reject: B1, B2, M1 to M6, 13 findings answered in part,
m1 to m20, the tells, 7 surviving `check.mjs` mutants, the legend toggle's cost) and the 16 system
gaps the flow screens' second revision found (`flows/REVISION.md`, "System gaps found", G1 to G16).
Status: **not reviewed.** It needs an independent review under `project/review.md`.

The work was interrupted by a container restart and finished by a second designer, who inventoried
what was done against the review, measured again every claim below that can be measured, fixed what did
not hold (see "Found after the restart"), took the waterfall and log-line gaps the first session had
declined, and wrote the mutant and speed sections. Nothing outside `design-system/` was edited;
`flows/`, `reviews/system-v4/` and `app/` were not touched; git was used read-only. "Before" is v4
exactly as reviewed: extracted from commit `f1c399a` (`git archive`, the commit that added the v4
review; it was `48a7bdb` before the branch's history was rewritten to drop vendored code, and its
`design-system/` is the same file for file), byte-identical in `src/`, `tokens.json`, `tools/` and the Chart preview to the copy the first
session took, with v4's `dist/` built from it by v4's own `build.mjs`. Nothing was published.

## How it was checked

- **Before and after images**: ten compositions (`compositions/`: a full dashboard, a monitor, a
  dialog over a long list, empty and error states, a 30-row table, charts after a filter round trip
  and a new pod, an agent's report, a secret shown once, a trace with its waterfall, log lines with a
  paused tail), rendered with `tools/shots.mjs scenario shots.json` from the same files on v4 and on
  v5 in the same session: both themes, 1440 and 400 px, a full screen at 1500 px, 400 px with a
  coarse pointer, 200% zoom, greyscale, keyboard focus. 53 composed pairs in `compare/` (natural
  size, side by side; palette-encoded keeping the 256 most frequent colours of each image exactly,
  so grounds, inks and series are exact and at most 1.2% of pixels, antialiasing, move to a near
  colour; 6.6 MB). All were rendered again after the restart: the images left by the first session
  were older than its compositions (the charts image said "auth" was brought forward; the composition
  had been changed to "search"). The v4 side renders v5 markup with v4's CSS and chart, so a class v4
  does not have shows unstyled there (the waterfall, the log lines); that is the honest picture of
  what v4 offered, not a regression.
- **Measurements**: hit areas, covered controls, drawn boxes reached by a neighbour and links
  inside sentences (`shots.mjs`, extended for m20), reserved against drawn chart height (a page
  served over HTTP with data held 600 ms), layout shift and every speed budget with
  `tools/speed.mjs` (corrected for M4), contrast as rendered (`check.mjs`), and `tools/mutants.mjs`.
  After the restart, every composition at 400 px with a coarse pointer, both themes: 0 hit areas
  under 44 px, 0 controls covered at their centre, 0 drawn boxes reached by a neighbour (dashboard 77
  areas, charts 55, long table 37, traces 28, claims 23, monitor 20, logs 15, states 10, secret 4,
  dialog 2); one link inside a sentence, listed (the claims page's sub-line naming the monitor the
  report is about: a secondary path, not the report's main one, which is reading and confirming
  claims); no sideways overflow at 400, 1440, 1500 px or 200% zoom; smallest
  text 11 px (`micro`).
- **Machine**: 4 cores shared with other jobs; the load average is recorded beside every number
  below. It was between 8 and 26 across both sessions, so by the harness's own rule (M4) no timing in
  this document can pass or fail a budget: they are printed and compared before against after in the
  same session, alternating in blocks, and layout shift (which does not depend on speed) is judged.

## Blockers

### B1. Filter round trip, "highest", the legend note

**Changed.** `assignSeries` (Chart preview, built into `dist/viz-chart.js`) and Chart README
"Series colour" rules 2 to 8. The view's map now records every series it has seen: its slot, or
0 for "seen in Other". A key in the map is never new again. A series already in Other is promoted
only into a slot no series has ever held in this view, never into a reserved one; a new series
takes a never-held slot, then the slot of an absent series (which is then recorded as in Other),
else joins Other. The readout's "highest" is computed over every drawn series including each member
of the Other band, and names a member as "highest: Other, checkout-api-…new01 3.3 cores". When any
series in Other has a higher maximum than the smallest coloured series, the legend note says so
("1 in Other is now larger than a coloured series") and the legend's action row offers **"Colour
the eight largest"**: a recolour the person chooses; nothing repaints by itself.

**Beyond the review's fix.** The review's rule alone makes a filter that removes every coloured
series show an all-grey chart, forever, in that view. The note and "Colour the eight largest" cover
that case too, as an explicit choice, so colour still never changes under someone without their
asking.

**Shows it.** `compare/v5-charts-1440-light.png` (and dark, 400): left panel, after "without the
three largest" and back. v4: slot 1 is the 9th largest (catalog-…403cb), the readout says "highest:
checkout-api-…b2d84 2.4 cores" while Other reaches 2.8. v5: the three largest are back in slots 1 to
3, the readout says "highest: checkout-api-…3742c 3.0 cores". Right panel, a new pod larger than all
36: v4 says "highest: …3742c 2.9" with the new pod hidden in Other at 3.3; v5 says "highest: Other,
checkout-api-7d9f8c6b5-new01 3.3 cores", the note says so and offers the recolour. The round trip and
the new pod are also controls in the Chart preview ("Without the three largest", "Add a pod larger
than the rest"). Rule as code, measured again after the restart with `assignSeries` taken verbatim
from each version's Chart preview (node; 36 series by rank, filter out the three largest, clear the
filter, then a pod larger than all 36): v5 slots 1 to 8 identical before and after, the new pod in
Other and every slot unchanged; v4 slots 1 to 3 held by the 9th to 11th largest after the round trip,
which is the review's image 01 reproduced from the code alone.

### B2. Chart height on touch phones

**Changed.** Every part of a chart takes its height from a custom property that the coarse-pointer
block overrides (`--chart-plot`, `--strip`, `--chart-foot`, `--legend-head`, `--legend-row`), and the
reservation (`.vz-chart[style*="--legend-rows"]`) is built from the same properties, so the reserved
and drawn heights cannot disagree on any pointer. The two things that could still wrap are gone:
the readout no longer takes its own line below 400 px (one line beside the zoom buttons, which also
answers m4), and the legend note is one line per fact, cut to fit, counted in `--legend-notes`. Other
adds two legend rows (its own and the action row). The fixture sets both properties per panel.

**Shows it.** Reserved against drawn height, fixture served over HTTP, data held 600 ms, every chart,
measured again after the restart: 1440 px fine pointer 369/369, 499/499, 569/569, 569/569, 499/499,
211/211; 400 px coarse 490/490, 720/720, 830/830, 830/830, 720/720, 292/292 (v4 reserved 384, 509, 534,
534, 509 and 254 against 496, 721, 820, 820, 721 and 300). Layout shift with the page loaded at 400 px,
coarse, scrolled to a chart, data 800 ms late, 20 runs alternating with v4, load 10 to 26 on 4 cores
(layout shift is judged at any load): v4 p75 0.053 (routes), 0.062 (services), **0.301** (pods),
0.074 (pods-all), **0.698** (backtest); v5 0.0000 on all five. Table in "Speed" below. `speed.mjs` now has a phone layout
(`fixtures/speed-phone.json`, 400 x 800, coarse, touch) with a "loaded scrolled to" row per chart.

The legend toggle's cost is answered under "Speed".

## Majors

### M1. Hue was the only channel without direct labels

**Changed.** (1) **Emphasis**: hovering a legend row, focusing it, or holding a finger on it brings
its line forward and draws every other line as a `series-other` hairline until it is let go
(`emphasise` in the chart; no layout). The Other row emphasises the band's edges in `ink`. (2) The
readout names the series **nearest** the pointer or finger (and the highest, when different and
the chart is at least 640 px), with an `ink` ring round that series' dot. (3) **A new palette with a
lightness stagger** (`tokens.json`, `series-1` to `series-8`, both themes): odd slots a darker step,
even slots a lighter one, neighbours at least 1.36:1 apart in luminance (light 1.70 to 1.95, dark
1.36 to 1.47). (4) **Secondary encoding where colour separation is below the floor**: no ordering of
eight hues passes all pairs (the dataviz method says so and the search confirmed it), so slots 1 to 4
are drawn solid and 5 to 8 dashed (`space-2` dash, `space-1` gap; the swatch shows two dashes), and
each group of four is chosen to pass the validator as all pairs. Thresholds keep a shorter, thinner
dash and their words. (5) Every slot reaches 3:1 on ground, raised, sunken, hover and rule, both
themes (light 3.12 to 7.73, dark 3.14 to 6.46), and is at least 8 (OKLab ×100) from every status and
action colour (m17). (6) `check.mjs` checks all of it (below).

The palette was searched, not picked: candidates in OKLCH at fixed luminance windows per step, beam
search over slot orders, scored on in-group colour-vision separation, normal-vision separation,
hue spread and chroma, with the status distances as constraints; the joint light/dark search kept
each slot's hue within 22° across themes. Validator (`dataviz/scripts/validate_palette.js`):

| | light | dark |
|---|---|---|
| Values | `#06578a #bb6c2e #a40255 #915adc #82431a #0e7eef #8027a1 #109071` | `#2d7cb7 #d9720c #cf3d84 #a872f6 #b56029 #4c95ef #ab55b1 #04a17e` |
| Adjacent, colour vision / normal | 14.3 / 21.1, pass | 9.7 / 19.1, pass |
| All pairs, slots 1–4 | 10.6 / 21.1, pass | 9.7 / 18.7, pass |
| All pairs, slots 5–8 | 13.9 / 21.4, pass | 9.7 / 19.1, pass |
| All pairs, all eight | 3.3 / 13.4, fail (the dash separates these) | 0.9 / 8.5, fail (same) |
| Band, chroma, 3:1 on ground and sunken (and raised in dark) | pass | pass |

v4 for comparison: all pairs failed at deutan 1.8 / normal 6.5 (light) and 1.4 / 7.1 (dark), and
light slots 2 to 5 were one grey (luminance ratios 1.00 to 1.01). Every figure in this table was measured again after the
restart with the same validator (adjacent, each dash group `--pairs all`, all eight `--pairs all`,
dark against `#121212`) and came out the same.

**Shows it.** `compare/v5-charts-grey-1440-light.png` and dark: the eight-series chart and five
routes ending within 41 ms, in greyscale; v5's lines alternate light and dark and 5 to 8 are dashed,
v4's are one grey; "search" is brought forward from its legend row. `compare/v5-dashboard-*`: the 8-,
36- and 200-series charts in both themes. The Chart preview at 1100 px (`dist/reference.html`).

### M2. The chart specification is closed

Each open choice, now one sentence in the Chart README and implemented in the preview:

| Open in v4 | v5 |
|---|---|
| Is a folded series new? | No: a key in the view's map is never new again (B1). |
| "Highest" over what? | Every drawn series, members of Other included, named "Other, …". |
| Two picked members of Other both `ink` | Up to three at once, `ink`, solid, dashed and dotted in the order chosen, the swatch showing the pattern; with three drawn the other members' rows are disabled and say why. |
| Sorting while the crosshair is set | Sorting uses the window's own values (Last, Min, Max), never the crosshair's; rows never move while reading; the figure head reads "At 13:02, ms" without a triangle and the name head says "by last value". Pressing the figure head clears the crosshair. |
| Direct-label text | One value: the most distinguishing label, cut in the middle; never several. No direct label for a single series (m5). |
| Ticks on a `plot-sm` plot | At most one interval per two `micro` lines of plot (32 px), at most four; the smallest round step that fits; with a threshold, the smallest fitting step through it. `plot`: 4 intervals; `plot-sm`: 2 (backtest 0, 1, 2 at 38 px). |
| Units | `scaleUnit`: bytes in binary units with power-of-two steps (0, 256, 512, 768 MiB in the preview's "Memory by service"), s/ms/µs to the unit where the largest value is at least 1, other units k or M on every number from 10,000; the unit at the top of the axis, never off the page (G8). |
| Precision; "0.0" in Other | Ticks carry exactly their step's decimals (2.5 prints 2.5: G9); values one significant digit finer; a non-zero value that would print as zero prints "< 0.1". |
| Zoom with no crosshair | The end of the range stays put, so a range ending now still ends now. |
| A viewer's filter and the stored map | The stored map is written only when an editor saves the panel; a viewer's filter, range, query or recolour changes their tab's copy. |
| Stacked charts | Not part of the component; the README says not to build them from it (with bar, heatmap, waterfall and log line). |
| Text form | Specified (order and content) and implemented: the preview's first chart shows it under "Text form". |

Also closed: the marker under the crosshair is named in the readout (m2); an interval label too long
for its room is cut to its first word rather than labelling time before the span (m3); an error after
a chart was drawn keeps the panel's height (`setError`, M6).

### M3. The main path inside a sentence

**The pattern, not the instance.** Timeline: a line may end with one standalone `vz-link` after its
`p` (CSS puts it under the sentence in the text column); a sentence holds no links. Rules (Every
form factor), Controls, Banner and the rubric's Touch row now say the same thing: a link inside a
sentence is text, exempt from the touch height, and therefore never the main path. Method step 7
says it. Banner, Changes and the claims composition moved their links out of sentences.
`shots.mjs` now measures links inside sentences and lists them instead of skipping them.

**Shows it.** `compare/v5-monitor-400-hit-areas-light.png`: History's "Read the report" and "See
the change" are standalone, outlined at 44 px; all v5 compositions at 400 px measure 0 controls
under 44 px, 0 covered, 0 drawn boxes reached by a neighbour; the one link inside a sentence left
(the claims page's sub-line, back to the monitor) is listed by the measure.

### M4. The harness

| Review | v5 `speed.mjs` |
|---|---|
| A frame added to `toggle` and `response` | The condition is checked in each frame callback and, when it matches, the end-of-frame task is posted from that same callback. |
| Typing measured during a re-run | After `press` (and `response`) the harness waits for `body[data-loaded]` to change, then 400 ms. |
| No phone layout | Per-scenario viewport and `coarse` (touch, coarse pointer); `fixtures/speed-phone.json` at 400 x 800 with taps and a touch-drag crosshair (`drag`). |
| No 200-series toggle | "Legend row toggle, 200 series" in both scenarios. |
| Load not recorded | Every run records the 1-minute load and the core count; a calibration task is timed first; each row prints its median load; a timing row whose runs mostly started with load above the cores is "not judged" (printed, never passed or failed); `--out` keeps all of it. |
| Layout shift only from a desktop load | `load-shift`: a separate load at url#region with data held `delay` ms, so the page opens scrolled to that region before its data arrives. |

### M5. The rubric

| Contradiction | Resolution in `project/review.md` |
|---|---|
| "Are the coloured series the largest" against "never repaint" | Many series asks whether they were the largest when first seen, and whether the note says so whenever Other holds something larger. |
| Budgets at major in Many series, blocker in Speed | Removed from Many series ("Budgets are judged under Speed"); one row, one level, stated in the preamble. |
| Touch "every control" against the in-sentence exemption | The row states the exemption and that the main path is never such a link (failing that is this row's failure). |
| Speed depends on load and a desktop layout | Speed asks for both layouts, before and after in the same session, load and cores recorded; a timing from a run over the cores is "not judged" and is measured again. |
| No second-channel question; FL-B5 a Contrast blocker to one reviewer, a pass to another | Contrast names every surface a series rests on (blocker); Charts asks whether every series can be told apart without hue (major). |

Also added: Narrow and zoom asks for layout shift on a load scrolled to a region; System asks
whether any preview or screen needs an inline style; Screen reader names "not every pointer move".

### M6. Gaps, and previews that stepped outside the system

| Gap | v5 |
|---|---|
| Dialog consequence sentence | `vz-dialog-text` |
| Sentence beside an action, small secondary paragraph | `vz-secondary` (and `data-size="sm"`); `vz-text` for prose in a page (also G14) |
| Notice's distance under its control | `vz-notice-group` |
| Spacer in the nav | `vz-nav-end` on the first right-hand link |
| After an action, with undo | `vz-done` (Button; rule in States): what is now true and Undo, in place, same height, focus to Undo |
| Sections | `vz-section` (heading and content `space-3` apart), `vz-sections` and `vz-split` columns `space-8` apart; a Section component with README and preview |
| Where a menu opens | `vz-menu-anchor`: under its button, left edges aligned, `data-align="end"` and `data-flip` when there is no room; a bottom sheet with a coarse pointer below 640 px; `vz-menu-note` and a confirming button inside (G3) |
| Empty or error at the plot's height | `.vz-chart > .vz-empty` at the plot's height. An error after a result was drawn (`setError`) lies over the plot at its height and the legend keeps the previous result's names and figures, inert (changed after the restart: the first version emptied the legend under "Showing the previous query", see below) |
| Time-range field | `vz-range` in a `fieldset.vz-field`: two typed mono times in the system's form, the zone stated, never the locale picker |
| Row-actions trigger | `td.vz-row-actions` with a quiet small "Actions…" button opening the row's menu |

**Inline styles.** No preview has one: `node tools/check.mjs project/components --no-render` lints
`<style>` blocks and `style=""` attributes as CSS and reports 0 literal values in 29 files (v4: 38 literal lengths in inline styles).
The only `style` attributes left in previews are the chart's documented `--legend-rows` and
`--legend-notes`, which hold counts, not values. Progress bars get their measured fraction from
script.

## The 13 findings answered in part

| Finding | Now |
|---|---|
| AR-M2 colour assignment and Other | B1. |
| AR-M7 units | M2 "Units" and "Precision". |
| AR-S1 assignment algorithm | Rules 2 to 8 and `assignSeries` say what "new" is. |
| AR-S3 series on ground, hover, raised in `check.mjs` | Series on ground, raised, sunken, hover and rule are pairings in `check.mjs`; the swatch's ring for `pressed` is checked as CSS and as rendered (mutants R9, N1). |
| AR-S10 units in charts | As AR-M7. |
| AR-S12 fixture and shared harness | M4; the fixture's own faults (m10). |
| FL-B1, FL-S1 links on touch | M3. |
| FL-B5 series without colour | M1. |
| FL-M2 Silence at night | `vz-done` ("Acknowledged by you at 15:16" and Undo; "Silenced until 16:16" and End silence) and the Silence menu with its note and yellow confirm (`compare/v5-monitor-silence-menu-*`). |
| FL-M10 Monitors at 200% zoom | `data-fold="wide"` folds below `breakpoint-wide`, for lists whose columns do not fit 640 px. |
| FL-S4 second channel | M1. |
| FL-S7 missing components; literal 800 px | M6; `vz-split` at `breakpoint-narrow`; m11. |

## Minors

| | v5 |
|---|---|
| m1 page state | One run of text, the mark inline at `space-3` beside a heading; `vz-qty` scales to its sentence (`qty-scale`, never below `data`), so times in the state line are mono like the timeline's (`compare/v5-monitor-400-*`). |
| m2 dropped marker words | The readout names a marker under the crosshair. |
| m3 interval label | Cut to its first word when it would label time before the span ("Firing" at 400 px). |
| m4 empty readout line | Gone: one line for readout and zoom. |
| m5 single series label | No direct label for one series. |
| m6 Cancel over the plot | The strip is `control-touch` tall with a coarse pointer; v4's dashboard measures Cancel reaching into the plot, v5's does not (`shots` log). |
| m7 fold | Folded words in `ink`, labels muted; `vz-phrase` keeps "> 500 ms" and "for 5 min" whole; `data-fold="wide"`. |
| m8 scrolling tables | A `rule-control` edge at the right while there is more to scroll (scroll timeline); `vz-cut` cuts identifiers in the middle; a left column after a right-aligned one starts `space-6` in. |
| m9 `check.mjs` teeth | Below. |
| m10 fixture | Tables have captions ("30 of 200 series, highest last value first"); the age appears only once something is drawn (its space reserved); a Chart/Table switch per panel replaces the page-wide one. |
| m11 breakpoints | `breakpoint-narrow` and `breakpoint-wide` tokens; every condition in the CSS is checked against them; no lint exemptions left. |
| m12 legend focus ring | Round the whole row. |
| m13 live region on every move | A separate live region: keyboard moves at once, pointer after 500 ms at rest. |
| m14 `.vz-legend` | Removed (no screen in `flows/` uses it). |
| m15 coarse rows everywhere | Only rows that hold a link or a control. |
| m16 previews teaching the wrong thing | Green beside default "Silence…", never beside yellow; the delete dialog has no placeholder and Delete is disabled until the name is typed; "Show 20 more of Other". |
| m17 series near status colours | Every slot at least 8 from every status and action colour, checked. |
| m18 v1–v3 leftovers | `optimizeLegibility` and `antialiased` removed; untoned buttons in `ui` (400), toned in `ui-strong`; tab ring kept off the letters by side padding; a status word in a stat context is `ink`; the Cover's colour blocks replaced by a chart drawn with the chart's own classes. Not changed: the select's arrow (see "Disagreements") and the nav's last items at 400 px (a scrolling strip by design; the measure lists them). |
| m19 secret at 400 px | The well on its own line, Reveal and Copy key together under it. |
| m20 `shots.mjs` measure | Reports links inside sentences, controls covered at their centre and drawn boxes reached by a neighbour; skips only what is invisible or behind a modal. |
| Tells | Middle dots no longer sit against marks (claim provenance parts are spaced; rule in Words); an agent's line in a timeline has the agent's rule as its mark, and an agent's banner has no mark of its own, so no "▬ \|" or "– \|"; the ⌘↵ chip is gone from buttons (rule: shortcuts in menus and tooltips); the roll-call of admired products and the aphoristic principle titles are rewritten as plain statements; the Cover is the product, not colour blocks. |

## Found after the restart

Inventory against the review, then every claim re-measured. Six claims did not hold in the work as
left; each is fixed, imaged and, where a check could see it, guarded.

| What was claimed | What the images and measures showed | Fix | Shows it |
|---|---|---|---|
| m12: the legend's focus ring is round the whole row | The ring was an outline on the `tr`; the first cell is positioned (sticky), so it painted over the outline and the ring showed only beside the figures (first session's `compare/v5-charts-1440-light.png`, "search" row) | The ring is drawn by the cells (`box-shadow` in `focus` on every cell, plus the left side on the first and the right side on the last); the same for a waterfall row. `check.mjs` part 2 fails if a row-control's ring is not drawn by its cells (mutant N10) | `compare/v5-charts-1440-*` (the "search" row), `compare/v5-traces-keyboard-1440-*` |
| m6, B2: with a coarse pointer the waiting line lies over the strip, never over the plot | The strip grows to `control-touch` (44 px) on touch, but the chart still drew the plot `space-6` (24 px) from its top, so the waiting line's ground covered the top 20 px of data: on the 400 px dashboard the catalog line was hidden from 09:16 to 10:00 | The plot's top is the strip's height, read from `--strip` (Chart README, "The strip above the plot"). The SVG's height was already the strip plus the plot, so no reserved height changed | `compare/v5-dashboard-400-*`, "Request rate by service" (v5 left: line hidden under "Waiting for 2 of 6 shards") |
| M6: an error after a result was drawn keeps the panel's height | It did, as an empty space: the legend was emptied under a head that said "Showing the previous query" and its age, so the head described nothing on screen (a Stale data blocker by the rubric), and 8 reserved legend rows were blank (550 px at 400 px) | The message lies over the plot at its height (the plot stays laid out, hidden, so nothing moves and the next result draws at once; the first version also could not redraw after an error, because it read the hidden plot's width as 0); the legend keeps the previous result's names and figures and is inert. The head's words are now true of what is shown. `shots.mjs` skips inert controls | `compare/v5-states-*`, `compare/v5-dashboard-*` ("Request rate by service, being edited") |
| m9: the reviewer's seven surviving mutants are caught | R10 (`ink-muted` on `pressed` in the legend) survived: the audit chose Other in every chart before forcing a press, and Other's count is the only muted legend text, so the muted-on-pressed pairing never rendered | A press pass on the previews as they open, before anything is chosen. R10 now fails with "28 series #6b6b6b on #d6d6d6 3.67:1" | Mutants table below |
| G13: the row whose detail is shown is `rule` with an `ink` edge | In a folded table the fill was on the cells, so a chosen or hovered folded row was filled in patches with ground between them ("Slowest traces" at 1440 in a half column) | In the folded form the row carries the hover, chosen and pressed fill and its cells are transparent (Table README) | `compare/v5-traces-*` |
| Images match the compositions | The 42 images predated the last edits to the compositions | All 53 re-rendered from the files as they are | `compare/` |

Also corrected: the dashboard's error panel was titled "Error ratio by service" over request-rate data
(it showed nothing, so it did not matter before; now that the legend stays it would be a figure under
the wrong title): it is now "Request rate by service, being edited". A key-value name now sits on its
value's baseline (the 400 px monitor's "Query" sat above its query well). "updated just now" no
longer sets the words "just now" in mono.

## `check.mjs`: what it checks now, and its mutants

Rewritten in four parts (header of `tools/check.mjs`): token pairings and the palette as a palette;
the component CSS parsed as rules (so a reformat cannot misfire and an override anywhere is found);
a rendered audit of all 30 previews (every preview but the Cover) in both themes, first as they open
under a forced press (added after the restart: this is the pass that catches R10), then at rest with
legend rows chosen, a row brought forward and Other opened, then under a forced hover and a forced
press, measuring every text against the fill actually behind it and every swatch, line and waterfall
bar against its ring or surface; and the literal lint, which now covers angles, non-geometric
percentages, unitless weights, line heights, line clamps and scales, HTML `<style>` and `style=""`,
and requires a reason after `token-lint-ignore`. Part 2 also fails a row that is one control (a legend
row, a waterfall span) whose focus ring is not drawn by its cells. New pairings: status marks on
`rule` and `pressed` (a failed span or a status in the row whose detail is shown), `ink-muted` on
`pressed` (a waterfall bar in a pressed row). `tools/mutants.mjs` applies each mutant to a copy in a
temporary folder and runs the check there; the source tree is never edited.

`node tools/mutants.mjs` after the restart, on a copy in the session scratchpad (never the tree), run
01:48:00 to 01:59:35 UTC with the 1-minute load at 10.09 to 7.28 on 4 cores (timing does not
affect the result). **All 30 mutants are caught and the harmless reformatting passes.** R1 to R18 are
the v4 review's sixteen (R1 to R8 caught then; R9 to R17 its seven survivors, with "literal deg, %
and unitless values" split into R14, R15 and R16; R18 the misfire); N1 to N8 are the first session's; N9 to N13 were added after the restart, for the
ring and the two new components. R10 survived the first session's check: it is caught by the
press pass on the previews as opened, added after the restart.

| Mutant | What was broken | Expected | Result | First line check.mjs printed |
| R1 | swatch ring removed | caught | caught | FAIL  .vz-swatch has lost its ground ring (0 0 0 var(--stroke) var(--ground)) |
| R2 | pressed equal to hover (light) | caught | caught | FAIL  pressed beside hover [light]  1.00 < 1.1  (a press must differ from hover) |
| R3 | series-4 back to v3 #eda100 (light) | caught | caught | FAIL  series-4 on ground [light]  2.17 < 3  (chart series and its swatch) |
| R4 | crosshair dot edge to rule | caught | caught | FAIL  .vz-plot .vz-dot[data-series] stroke var(--rule) (line 295): the crosshair dot keeps its ground edge |
| R5 | status-info equal to blue (light) | caught | caught | FAIL  status-info too close to blue [light]: a status must not look like the primary action |
| R6 | two near-identical neighbours (series-3 a copy of series-2, light) | caught | caught | FAIL  series-2 beside series-3 [light]  lightness step 1.01 < 1.3 (neighbours alternate darker and lighter) |
| R7 | a literal 3px | caught | caught | LITERAL length  src/components.css:589  3px |
| R8 | series-other near white (light) | caught | caught | FAIL  series-other on ground [light]  1.23 < 3  (edge of the Other band, a switched-off swatch on any row, a line stepped back) |
| R9 | swatch ring overridden on hover: tr:hover .vz-swatch { box-shadow: none } | caught | caught | FAIL  .vz-table.vz-legend-table tr:hover .vz-swatch sets box-shadow: none (line 589): the swatch must keep its ground ring (0 0 0 var(--stroke) var(-- |
| R10 | ink-muted on pressed in the legend (the pressed override removed) | caught | caught | FAIL  rendered press, as opened: text "28 series" #6b6b6b on #d6d6d6 3.67:1 < 4.5  light Chart <span.vz-series-rest> |
| R11 | ink-muted on rule in the legend (the chosen override removed) | caught | caught | FAIL  rendered at rest: text "28 series" #6b6b6b on #e4e4e4 4.19:1 < 4.5  light Chart <span.vz-series-rest> |
| R12 | the plot filled with hover on hover | caught | caught | FAIL  .vz-plot:hover sets background (line 589): a chart has no fill of its own; series are only checked on ground and raised |
| R13 | series-8 set to status-critical (light) | caught | caught | FAIL  series-8 [light] is 0.0 from status-critical (< 8): a series must not look like a state or an action |
| R14 | a literal angle (deg) | caught | caught | LITERAL angle  src/components.css:589  45deg |
| R15 | a literal percentage | caught | caught | LITERAL percentage  src/components.css:589  37% |
| R16 | a literal unitless weight | caught | caught | LITERAL unitless  src/components.css:589  font-weight: 600 |
| R17 | an opaque scrim (light) | caught | caught | FAIL  scrim [light] alpha 1 outside 0.30–0.75: the page must stay recognisable and the dialog must stand off it |
| R18 | harmless: the swatch rule reformatted onto two lines (v4 misfired here) | passes | passes |  |
| N1 | swatch ring removed on a pressed row only | caught | caught | FAIL  .vz-table.vz-legend-table tbody tr[data-key]:active .vz-swatch sets box-shadow: none (line 589): the swatch must keep its ground ring (0 0 0 var |
| N2 | neighbours at one lightness (series-2 as dark as series-1, light) | caught | caught | FAIL  series-1 beside series-2 [light]  lightness step 1.18 < 1.3 (neighbours alternate darker and lighter) |
| N3 | slot 7 drawn solid (its dash removed) | caught | caught | FAIL  [data-series="7"] has no --pattern: slots 5 to 8 must be dashed, the second channel beside colour |
| N4 | lines that step back drawn in rule (too faint to follow) | caught | caught | FAIL  rendered at rest: series line #e4e4e4 on #ffffff 1.27:1 < 3  light Chart <path> |
| N5 | a breakpoint that is not a token (800px) | caught | caught | FAIL  condition "@container (max-width: 799px)" (line 589) uses 799px, which is not a breakpoint token (640, 1200px) |
| N6 | token-lint-ignore without a reason | caught | caught | LITERAL ignore-without-reason  src/components.css:589  token-lint-ignore |
| N7 | a series in the dark theme below 3:1 on rule | caught | caught | FAIL  series-1 on ground [dark]  2.19 < 3  (chart series and its swatch) |
| N8 | chosen legend row text in ink-muted | caught | caught | FAIL  rendered at rest: text "POST /v2/orders" #6b6b6b on #e4e4e4 4.19:1 < 4.5  light Chart <span.vz-series-name> |
| N9 | a waterfall bar drawn in rule (too faint to read as a span) | caught | caught | FAIL  rendered press, as opened: waterfall bar #e4e4e4 on #d6d6d6 1.14:1 < 3  light Waterfall <span.vz-waterfall-bar> |
| N10 | the legend row's ring back to an outline on the row (painted under its first cell) | caught | caught | FAIL  the row of .vz-series has no focus ring drawn by its cells (td, first and last cell, box-shadow in focus): a keyboard user cannot see which row  |
| N11 | a matched search term in ink-muted (4.19:1 on its rule fill) | caught | caught | FAIL  rendered press, as opened: text "pool" #6b6b6b on #e4e4e4 4.19:1 < 4.5  light Log <mark.vz-match> |
| N12 | "3 spans inside" in ink-muted (3.67:1 when its row is pressed) | caught | caught | FAIL  rendered press, as opened: text "3 spans inside, 1 failed" #6b6b6b on #d6d6d6 3.67:1 < 4.5  light Waterfall <span.vz-waterfall-inside> |
| N13 | a literal line count for a cut log message | caught | caught | LITERAL unitless  src/components.css:589  line-clamp: 4 |

## Speed

Measured here, on the system's fixture page (a floor, not the application), after the restart, with
the v5 harness for both versions: v4's fixture built from commit `f1c399a`, v5's from this tree.
Reference setup: Chromium headless, CPU 4x, Fast 4G. **Alternating**: four rounds of v4 desktop, v5
desktop, v4 phone, v5 phone, 5 runs each, so before and after shared the load; 20 runs per version and
layout, merged (`speed/v4-desktop.json`, `v5-desktop.json`, `v4-phone.json`, `v5-phone.json` keep every
run with the load at its start; the scenarios are `speed/compare-desktop.json` and `compare-phone.json`,
the rows both fixtures have). The first session's 20-run v4 desktop set was replaced by this one.

**The machine was never quiet**: the 1-minute load average was 10 to 26 on 4 cores and the calibration
task took 359 to 887 ms against about 100 ms idle, so by the harness's rule every timing row is "not
judged" either way. Layout shift does not depend on speed and is judged. Timings are printed so the
direction can be read; a pass needs a quiet machine.

**Desktop, 1440 x 900, fine pointer** (4 + 4 blocks of 5 runs, alternating; load at run start v4 13.9 to 22.6, v5 12.6 to 24.5 on 4 cores; calibration task v4 425, 579, 681, 439 ms, v5 535, 593, 805, 382 ms, about 100 ms idle)

| Row | Budget | v4 p75 (median, worst) | v5 p75 (median, worst) | Load, median v4 / v5 | Judged? |
|---|---|---|---|---|---|
| Press: Run query | 50 ms | 18 (17, 49) | 21 (16, 69) | 17.8 / 17.5 | not judged (load > cores) |
| Typing in the query editor | 50 ms | 42 (20, 229) | 46 (20, 270) | 17.8 / 17.1 | not judged (load > cores) |
| Crosshair, 3 series | 50 ms | 44 (30, 87) | 63 (28, 136) | 18.0 / 17.1 | not judged (load > cores) |
| Crosshair, 36 series | 50 ms | 40 (34, 136) | 40 (35, 166) | 18.0 / 17.1 | not judged (load > cores) |
| Crosshair, 200 series | 50 ms | 37 (29, 94) | 41 (35, 149) | 18.0 / 17.1 | not judged (load > cores) |
| Legend row toggle, 36 series | 100 ms | 92 (71, 308) | 70 (58, 74) | 18.0 / 17.1 | not judged (load > cores) |
| Legend row toggle, 200 series | 100 ms | 136 (105, 468) | 57 (48, 102) | 18.0 / 17.1 | not judged (load > cores) |
| Response to paint, 36 series | 100 ms | 34 (24, 106) | 72 (43, 199) | 18.3 / 16.5 | not judged (load > cores) |
| Response to paint, 200 series | 100 ms | 31 (23, 103) | 40 (23, 113) | 18.3 / 16.5 | not judged (load > cores) |
| Layout shift, load and run | 0.05 | 0.0004 (0.0004, 0.0005) | 0.0004 (0.0004, 0.0005) | 18.3 / 16.5 | judged: v5 within |
| Layout shift, loaded scrolled to CPU by pod | 0.05 | 0.0003 (0.0003, 0.0003) | 0.0002 (0.0002, 0.0002) | 18.3 / 17.1 | judged: v5 within |
| Worst interaction (Event Timing) | 200 ms | 248 (160, 816) | 168 (112, 360) | 18.3 / 16.5 | not judged (load > cores) |

**Phone, 400 x 800, coarse pointer and touch** (4 + 4 blocks of 5 runs, alternating; load at run start v4 12.2 to 25.6, v5 10.4 to 23.1 on 4 cores; calibration task v4 606, 626, 884, 434 ms, v5 887, 762, 441, 359 ms, about 100 ms idle)

| Row | Budget | v4 p75 (median, worst) | v5 p75 (median, worst) | Load, median v4 / v5 | Judged? |
|---|---|---|---|---|---|
| Press: Run query | 50 ms | 36 (18, 124) | 29 (19, 116) | 19.7 / 18.9 | not judged (load > cores) |
| Typing in the query editor | 50 ms | 35 (29, 288) | 45 (27, 105) | 19.7 / 18.9 | not judged (load > cores) |
| Crosshair by touch drag, 36 series | 50 ms | 52 (49, 111) | 63 (52, 204) | 19.7 / 18.3 | not judged (load > cores) |
| Legend row toggle, 36 series | 100 ms | 79 (68, 334) | 84 (71, 197) | 19.7 / 18.3 | not judged (load > cores) |
| Legend row toggle, 200 series | 100 ms | 87 (79, 119) | 78 (57, 216) | 19.7 / 18.3 | not judged (load > cores) |
| Response to paint, 36 series | 100 ms | 33 (26, 71) | 44 (28, 69) | 19.7 / 18.3 | not judged (load > cores) |
| Response to paint, 200 series | 100 ms | 24 (22, 169) | 26 (21, 37) | 19.7 / 18.3 | not judged (load > cores) |
| Layout shift, load and run | 0.05 | 0.0000 (0.0000, 0.0000) | 0.0000 (0.0000, 0.0000) | 19.7 / 18.3 | judged: v5 within |
| Layout shift, loaded scrolled to CPU by pod | 0.05 | 0.3014 (0.0859, 0.3014) | 0.0000 (0.0000, 0.0000) | 19.6 / 19.3 | judged: v5 within |
| Layout shift, loaded scrolled to Latency by route | 0.05 | 0.0530 (0.0530, 0.0530) | 0.0000 (0.0000, 0.0000) | 19.6 / 19.3 | judged: v5 within |
| Layout shift, loaded scrolled to Request rate | 0.05 | 0.0623 (0.0623, 0.0623) | 0.0000 (0.0000, 0.0000) | 19.6 / 19.3 | judged: v5 within |
| Layout shift, loaded scrolled to CPU by pod, every namespace | 0.05 | 0.0736 (0.0736, 0.1563) | 0.0000 (0.0000, 0.0000) | 19.6 / 19.3 | judged: v5 within |
| Layout shift, loaded scrolled to the backtest | 0.05 | 0.6981 (0.6217, 0.8532) | 0.0000 (0.0000, 0.0000) | 19.6 / 19.3 | judged: v5 within |
| Worst interaction (Event Timing) | 200 ms | 128 (112, 336) | 160 (104, 352) | 19.7 / 17.8 | not judged (load > cores) |

What the numbers say, and what they do not:

- **Layout shift, judged: v5 is within budget everywhere; v4 was not on a phone.** Loaded at 400 px
  with a coarse pointer, scrolled to a chart, data 800 ms late: v4 0.053 to 0.698 at the 75th
  percentile on all five charts (the backtest worst, at 0.85), v5 0.0000 on all five. This is B2. The
  reserved against drawn heights behind it, measured with every data response held 600 ms
  (`fixtures` page over HTTP): v5 at 1440 px 369/369, 499/499, 569/569, 569/569, 499/499, 211/211; at 400
  px coarse 490/490, 720/720, 830/830, 830/830, 720/720, 292/292. v4 matched on desktop and reserved
  384, 509, 534, 534, 509, 254 against 496, 721, 820, 820, 721, 300 on the phone.
- **The legend toggle, B2's second half and the review's request.** Desktop p75 at 36 series 92 to
  70 ms, at 200 series 136 to 57 ms (medians 71 to 58 and 105 to 48; v4's worst 468 ms, v5's 102). On
  the phone the 200-series toggle went from 87 to 78 ms and the 36-series stayed level (79, 84), with
  v5's worst runs higher (197, 216 ms against 334, 119): under this load the phone rows do not
  separate. The change is structural (a toggle sets `display` on the series' paths and the rows'
  attributes, recomputes the axis from numbers already held, and redraws the plot only if the axis or
  the direct labels change), so its cost no longer grows with the series count: v4 grew 92 to 136 ms
  from 36 to 200 series, v5 70 to 57.
- **Response to paint, 36 series, is slower in v5** (desktop p75 34 to 72 ms, median 24 to 43; phone
  p75 33 to 44). Checked directly, as a counterfactual: the same data redrawn by each version's chart
  on its own fixture page, alternating, CPU 4x, 120 draws each (`setData` to the end of the painted
  frame), load 11 to 13: 36 series v4 median 41.8, v5 51.7 ms; 200 series v4 88.4, v5 55.9 ms. Tuning
  step tried: v5 with the dashes of slots 5 to 8 switched off, load 9.5 to 10.6: 36 series v4 44.9, v5
  48.6 ms; 200 series v4 89.4, v5 52.3 ms. So about half of the 36-series difference is drawing four
  dashed lines (the second channel M1 asked for), the rest is within the run-to-run spread of v4
  itself (41.8 against 44.9); at 200 series v5 is 33 to 37 ms faster. Not tuned further: every figure
  is under the 100 ms budget at the median and p75 even on this machine.
- **Typing and crosshair rows** move by a few milliseconds in both directions between the two
  versions with worst runs over 100 ms in both; nothing in v5 changed the editor or the crosshair
  path. They are not evidence either way at this load.
- **Not measured in this comparison**: the rows only v5's fixture has (one panel to a table and back,
  which replaced v4's page-wide switch). `fixtures/speed.json` and `speed-phone.json` measure them on
  v5 alone.

## The flow screens' system gaps (`flows/REVISION.md`)

| Gap | Taken? |
|---|---|
| G1 skip link takes 32 px | Taken: `.vz-skip:not(:focus)` is visually hidden and takes no space; on focus it is placed over the nav. Every v4 side in `compare/` starts its nav 32 px lower than the v5 side. |
| G2 page state | Taken (m1). |
| G3 menu anatomy and anchoring | Taken (M6: `vz-menu-anchor`, `vz-menu-note`, a confirming `vz-controls`). |
| G4 `vz-help` a flex row | Taken: one run of text, the mark inline. |
| G5 trace waterfall | Taken (after the restart; the first session had declined it as needing its own design pass, which it got): **Waterfall** (`project/components/Waterfall/`). A treegrid in a table: spans in start order, indented by depth; Took, Own (length less the time covered by spans inside) and Starts at; the bar as `--at`/`--len` fractions of the trace on one scale, `ink-muted`, and `ink` with a strong name where a span's own time is a tenth of the trace or more (lightness and weight, never a series or status colour); a failed span has the critical mark, and a collapsed span says "3 spans inside, 1 failed" so collapsing never hides a failure; collapse with a toggle, a trace over 200 spans opens collapsed except the paths to the spans in `ink`; the name is the span's own target (the detail under the table, `aria-selected`); one tab stop with arrow keys; the narrow form puts the bar on its own full-width line so every bar keeps one scale. `compare/v5-traces-*` (v4 side: the same markup, unstyled). |
| G6 log line | Taken: **Log** (`project/components/Log/`). Time with milliseconds as the key; the level as a word, with the status mark for error and warn only, dropped as a column when the search names one level; the message wraps in mono keeping its line breaks (never a sideways scroll: the end of a line is often the point) and is cut after `clamp-lines` (a new token, 4) with "Show all 31 lines" opening it in place; a matched term is `vz-match` (weight on `rule`, like a diff insertion); the live tail is held while the person reads, with a real count ("Show 214 newer lines") and the meta saying "paused at 15:16:02"; the narrow form keeps the message at full width and size. `compare/v5-logs-*`, `compare/v5-logs-line-open-1440-light.png`. |
| G7 folded label's space swallowed | Taken: the `data-label` prefix has its own margin and normal word spacing. |
| G8 long axis unit off the page | Taken: a unit wider than the axis gutter starts at the chart's left edge. |
| G9 a 2.5 step printed "3" | Taken: ticks carry exactly their step's decimals. Measured with each version's own formatter (node): v5 prints a 2.5 step as 0.0 2.5 5.0 7.5 10.0 and a 0.25 step as 0.00 0.25 0.50 0.75 1.00; v4 printed 0 3 5 8 10 and 0.0 0.3 0.5 0.8 1.0. |
| G10 textarea | Taken: `textarea.vz-input` (three lines tall at rest, grows by hand; `body` size with a coarse pointer). |
| G11 outbound message | Not taken: its look belongs to the phone and chat products; the content form the flows use (`vz-kv`, `vz-diff`) is right. |
| G12 a link styled as a button underlined | Taken: `.vz-button` has no underline. |
| G13 the row whose detail is shown | Taken: `aria-current`/`aria-selected` rows on `rule` with an `ink` edge on the key. |
| G14 body paragraph | Taken: `vz-text`, `vz-secondary`. |
| G15 agent marker on a chart | Taken: a marker with `agent: true` says "Agent:" and draws the agent's rule before its word. |
| G16 "notification sent", "escalated" | Taken as a rule, not a mark: those events take `info` (the bar); who was told is in the sentence. A new shape would add vocabulary for an event that has no state. |

**Class names.** Nothing was renamed. Removed: `.vz-legend` (unused by the flows). Behaviour that
changed under the same names: `vz-page-state` (a block, not a flex row: a mark and words in one
span still work), `vz-help` (a block), `vz-split` (one column below 640 px, not 800 px; its columns
are `space-8` apart), `vz-secret-row` (the well takes the whole line), untoned buttons are weight
400, `vz-claim-by` (parts spaced, so drop the " · " separators), table rows with nothing to tap stay
`row` tall on touch, and the chart's foot is one line. New: `vz-text`, `vz-secondary`, `vz-phrase`,
`vz-cut`, `vz-done`, `vz-section`, `vz-sections`, `vz-notice-group`, `vz-nav-end`, `vz-menu-anchor`,
`vz-menu-note`, `vz-range`, `vz-row-actions`, `vz-dialog-text`, `vz-text-form`, `vz-details`,
`vz-sr`, `vz-mark[data-state="agent"]`, `textarea.vz-input`, `data-fold="wide"`; after the restart,
`vz-waterfall` (with `vz-waterfall-span`, `-name`, `-inside`, `-time`, `-bar`, `-scale`, `vz-tree-toggle`,
`vz-tree-gap`), `vz-log` (with `vz-log-level`, `-msg`, `-text`, `-tail`) and `vz-match`; the token
`clamp-lines`. Chart API additions: `toggle`, `setError` (and `data-error` on the chart while it holds),
markers' `agent`, `--legend-notes`. Behaviour changed under the same names after the restart: a folded
table's row, not its cells, carries its fill; `vz-kv` aligns names to their value's baseline; a chart's
plot starts under `--strip`.

## Migration for the flow screens and the app

1. Every `vz-chart` that knows its last result sets `--legend-rows` (coloured series, plus 2 with an
   Other) and `--legend-notes` (shared labels: 1 when more than one series; Other: 1).
2. Timeline links move out of the `p` to a sibling `a.vz-link`; agent lines take
   `<span class="vz-mark" data-state="agent">` and lose `vz-agent` on the `p`.
3. Agent banners drop their `vz-mark`. Claim provenance lines drop " · ".
4. Replace `<span style="flex:1"></span>` in the nav with `class="vz-nav-end"` on the first right link.
5. Replace hand-set paragraph margins with `vz-text`/`vz-secondary`, sections with `vz-section`.
6. Acknowledge, Silence, Confirm: replace the button in place with `vz-done` after the action.
7. Remove `⌘↵` chips from buttons. Remove the G1 to G4, G7, G10, G12 to G14 work-arounds (`flow-*`).
   Screen 9's waterfall becomes `vz-waterfall` (`flow-indent` is `aria-level`, `flow-bar` is
   `vz-waterfall-bar` with `--at`/`--len` as fractions, not percentages, `flow-scale` is
   `vz-waterfall-scale`, `data-slow` is `data-heavy`, decided by own time); screen 10's lines become
   `vz-log` (`flow-wrap` is `vz-log-msg`, the level a column or a caption, "Show 214 newer lines" in
   `vz-log-tail`).
8. Series colours changed in both themes; images of charts must be regenerated.

## Disagreements, and what was not done

- **Series on `pressed`.** Every slot reaches 3:1 on every surface a series is drawn on or its
  swatch rests on for as long as someone likes (ground, raised, sunken, hover, rule), but not on
  `pressed` (light 2.73 to 2.75 for slots 2, 6, 8; dark 2.80 to 2.81 for 1, 3, 5, 7). A press lasts as
  long as a finger is down, and there the swatch's own `ground` ring carries it; the ring is checked
  as CSS and as rendered. I searched for a palette that also clears `pressed`: in light it forces
  every slot to luminance ≤ 0.186, which removes teal, ochre and every light hue (C ≥ 0.11 cannot be
  reached), leaving four purples; in dark no palette with the lightness stagger exists inside the
  validator's band. Lowering `pressed` contrast instead would make presses invisible again (AR-M6).
- **All pairs at the normal-vision floor across all eight**, as the review's step (2) asked, cannot
  be reached by any palette of eight (the validator's own documentation, and the search). The
  review's step (3) offered two ways out; I took the dash, keeping eight colours and two groups that
  each pass all pairs, over colouring six.
- **The select's arrow** stays as two hard-stop gradients in `currentColor`: a `select` cannot hold
  an element, and the alternatives (a wrapper on every select, a data URI that cannot follow the
  theme) are worse. The colour rule now says this is not a colour gradient and is the only one.
- **"Refuse to report a blocker row when load exceeds the cores"** is implemented as "not judged",
  not as silence: on this machine that means no timing in v5 is judged at all. The numbers are
  printed with their load so the reviewer can weigh them; a quiet machine is needed to judge them.
- **Stacked charts** are declared out of scope rather than specified (M2).
- **G11** above (an outbound message's look belongs to the phone and chat products).
- **The waterfall's bars take an inline style**, `--at` and `--len`, against the rubric's "does any
  preview need an inline style". They are data (a span's start and length as fractions of the trace),
  written by whatever draws the rows, as a chart writes its SVG coordinates; no design value can be
  written there (the lint reads `style=""` as CSS and passes only bare numbers in custom properties).
  The alternative, a script in the system that reads `data-start` and `data-took` and sets the same
  properties, moves the same numbers into a dependency every screen would need.
- **The 200-span collapse rule and the live tail's once-a-second batching are specified, not
  measured**: the preview has 13 spans and a static tail. They need the application's own data to
  measure.
- Not checked: a screen reader by ear, Safari and Firefox (the table's scroll edge uses a scroll
  timeline), real touch hardware, enlarged text as distinct from zoom. `reference.html` was rebuilt
  but not re-imaged as one picture; its parts are in the compositions.

## Files

Tokens and CSS: `project/tokens.json` (version 5), `src/components.css`; generated `bundle.css`,
`dist/`. Rules: `project/README.md`, `project/method.md`, `project/review.md`; `README.md`.
Components: every README and preview touched above; new `project/components/Section/`,
`Waterfall/` and `Log/`. Tools:
`tools/css.mjs` (new), `build.mjs`, `check.mjs`, `mutants.mjs` (new), `shots.mjs`, `speed.mjs`,
`reference.mjs`. Fixture: `fixtures/build.mjs`, `speed.json`, `speed-phone.json` (new), `README.md`.
This folder: `compositions/` (`traces.html` and `logs.html` carry the Waterfall and Log previews'
rows unchanged, so screen and component show the same trace), `shots.json`, `compare/` (53 before/after pairs), `speed/` (scenarios and the raw
results of every block with their loads), this file.

Reproduce: `node tools/build.mjs && node tools/reference.mjs && node fixtures/build.mjs && node
tools/check.mjs && node tools/mutants.mjs && node tools/shots.mjs scenario reviews/system-v5/shots.json
<out> && node tools/speed.mjs fixtures/speed.json && node tools/speed.mjs fixtures/speed-phone.json`.
