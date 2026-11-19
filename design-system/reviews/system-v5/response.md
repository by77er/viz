# Design system v5: response to the v4 review

The input is `reviews/system-v4/review.md` (reject: B1, B2, M1 to M6, 13 findings answered in part,
m1 to m20, the tells, 7 surviving `check.mjs` mutants, the legend toggle's cost) and the 16 system
gaps the flow screens' second revision found (`flows/REVISION.md`, "System gaps found", G1 to G16).
Status: **not reviewed.** It needs an independent review under `project/review.md`.

Nothing outside `design-system/` was edited; `flows/`, `reviews/system-v4/` and `app/` were not
touched; git was not run, so "before" is a copy of v4 taken at the start of the work
(`dist/`, `project/`, `src/`, `tools/`, `fixtures/` in the session scratchpad), not a commit.
Nothing was published.

## How it was checked

- **Before and after images**: eight compositions (`compositions/`: a full dashboard, a monitor, a
  dialog over a long list, empty and error states, a 30-row table, charts after a filter round trip
  and a new pod, an agent's report, a secret shown once), rendered with `tools/shots.mjs scenario
  shots.json` from the same files on the v4 copy and on v5: both themes, 1440 and 400 px, a full
  screen at 1500 px, 400 px with a coarse pointer, 200% zoom, greyscale. 42 composed pairs in
  `compare/` (natural size, side by side, palette-encoded, 5.9 MB). The v4 side renders v5 markup
  with v4's CSS and chart, so a class v4 does not have shows unstyled there; that is the honest
  picture of what v4 offered, not a regression.
- **Measurements**: hit areas, covered controls, drawn boxes reached by a neighbour and links
  inside sentences (`shots.mjs`, extended for m20), reserved against drawn chart height (a page
  served over HTTP with data held 600 ms), layout shift and every speed budget with
  `tools/speed.mjs` (corrected for M4), contrast as rendered (`check.mjs`), and `tools/mutants.mjs`.
- **Machine**: 4 cores shared with other jobs; the load average is recorded beside every number
  below. It was between 8 and 17 for the whole session, so by the harness's own rule (M4) no
  timing in this document can pass or fail a budget: they are printed and compared before against
  after in the same session, and layout shift (which does not depend on speed) is judged.

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
than the rest"). Unit test of the rule (node, scratch): 36 series by rank, filter out the top 3, clear
it: slots 1 to 8 identical before and after.

### B2. Chart height on touch phones

**Changed.** Every part of a chart takes its height from a custom property that the coarse-pointer
block overrides (`--chart-plot`, `--strip`, `--chart-foot`, `--legend-head`, `--legend-row`), and the
reservation (`.vz-chart[style*="--legend-rows"]`) is built from the same properties, so the reserved
and drawn heights cannot disagree on any pointer. The two things that could still wrap are gone:
the readout no longer takes its own line below 400 px (one line beside the zoom buttons, which also
answers m4), and the legend note is one line per fact, cut to fit, counted in `--legend-notes`. Other
adds two legend rows (its own and the action row). The fixture sets both properties per panel.

**Shows it.** Reserved against drawn height, fixture served over HTTP, data held 600 ms, every chart:
1440 px fine pointer, 366/366, 491/491, 559/559, 559/559, 491/491, 210/210; 400 px coarse,
486/486, 711/711, 819/819, 819/819, 711/711, 290/290 (v4 reserved 384, 509, 534, 534 and 254 against
496, 721, 820, 820, 300). Layout shift with the page loaded at 400 px, coarse, scrolled to a chart,
data 800 ms late, one run each, load 9.1 to 9.5 on 4 cores: v4 0.053, 0.062, **0.086**, 0.074,
**0.520** (routes, services, pods, pods-all, backtest); v5 0.0000, 0.0000, 0.0000, 0.0000, 0.0038.
The 20-run figures are in "Speed" below. `speed.mjs` now has a phone layout
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
light slots 2 to 5 were one grey (luminance ratios 1.00 to 1.01).

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
| Empty or error at the plot's height | `.vz-chart > .vz-empty` at the plot's height; the chart's `setError` keeps the reserved height |
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

## `check.mjs`: what it checks now, and its mutants

Rewritten in four parts (header of `tools/check.mjs`): token pairings and the palette as a palette;
the component CSS parsed as rules (so a reformat cannot misfire and an override anywhere is found);
a rendered audit of all 28 previews (every preview but the Cover) in both themes at rest, with legend rows chosen, a row brought
forward, Other opened, then under a forced hover and a forced press, measuring every text against the
fill actually behind it and every swatch and line against its ring or surface; and the literal lint,
which now covers angles, non-geometric percentages, unitless weights, line heights and scales, HTML
`<style>` and `style=""`, and requires a reason after `token-lint-ignore`. `tools/mutants.mjs`
applies each mutant to a copy in a temporary folder and runs the check there; the source tree is
never edited.

MUTANTS_TABLE

## Speed

SPEED_TABLE

## The flow screens' system gaps (`flows/REVISION.md`)

| Gap | Taken? |
|---|---|
| G1 skip link takes 32 px | Taken: `.vz-skip:not(:focus)` is visually hidden and takes no space; on focus it is placed over the nav. |
| G2 page state | Taken (m1). |
| G3 menu anatomy and anchoring | Taken (M6: `vz-menu-anchor`, `vz-menu-note`, a confirming `vz-controls`). |
| G4 `vz-help` a flex row | Taken: one run of text, the mark inline. |
| G5 trace waterfall | Not taken: a waterfall needs its own design pass (the question, the presence test, a 2,000-span trace, the critical path, nesting, collapse) and the method's eight steps; a half-specified component would be built twice. The Chart README now says not to build it from Chart. |
| G6 log line | Not taken, for the same reason (levels, wrap or scroll, match highlight, live tail). |
| G7 folded label's space swallowed | Taken: the `data-label` prefix has its own margin and normal word spacing. |
| G8 long axis unit off the page | Taken: a unit wider than the axis gutter starts at the chart's left edge. |
| G9 a 2.5 step printed "3" | Taken: ticks carry exactly their step's decimals. |
| G10 textarea | Taken: `textarea.vz-input`. |
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
`vz-sr`, `vz-mark[data-state="agent"]`, `textarea.vz-input`, `data-fold="wide"`. Chart API
additions: `toggle`, `setError`, markers' `agent`, `--legend-notes`.

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
- **G5, G6, G11** above.
- Not checked: a screen reader by ear, Safari and Firefox (the table's scroll edge uses a scroll
  timeline), real touch hardware, enlarged text as distinct from zoom. `reference.html` was rebuilt
  but not re-imaged as one picture; its parts are in the compositions.

## Files

Tokens and CSS: `project/tokens.json` (version 5), `src/components.css`; generated `bundle.css`,
`dist/`. Rules: `project/README.md`, `project/method.md`, `project/review.md`; `README.md`.
Components: every README and preview touched above; new `project/components/Section/`. Tools:
`tools/css.mjs` (new), `build.mjs`, `check.mjs`, `mutants.mjs` (new), `shots.mjs`, `speed.mjs`,
`reference.mjs`. Fixture: `fixtures/build.mjs`, `speed.json`, `speed-phone.json` (new), `README.md`.
This folder: `compositions/`, `shots.json`, `compare/` (42 before/after pairs), `speed/` (scenarios
and the raw results with their loads), this file.

Reproduce: `node tools/build.mjs && node tools/reference.mjs && node fixtures/build.mjs && node
tools/check.mjs && node tools/mutants.mjs && node tools/shots.mjs scenario reviews/system-v5/shots.json
<out> && node tools/speed.mjs fixtures/speed.json && node tools/speed.mjs fixtures/speed-phone.json`.
