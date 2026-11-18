# Review: viz design system, v4

Reviewed 2026-11-18 against `project/review.md`, by a reviewer who did not write the revision and
was given only its change list (`CHANGES.md`). Inputs: the system as it stands on disk
(`project/`, `src/components.css`, `tools/`, `fixtures/`), the earlier reviews
(`reviews/system-v1..v3`) and the two rejections this revision answers
(`reviews/app-restyle/review.md`, `reviews/flows-v1/review.md`, `reviews/app-restyle/PR.md`).
The author's images were not used as evidence; every image cited below was rendered here.

## Verdict: reject

Two blockers and six majors. The rubric's definition is "any blocker, or three or more majors",
so the revision is re-imaged and reviewed again. Nothing should be built on the series-colour
rule or the chart's height reservation until B1 and B2 are fixed; most of the rest of v4 can be
built on now (see "Keep").

The revision is substantial and mostly right: 26 of the 39 findings it answers are answered
fully and the other 13 in part (table below); contrast and the literal-value lint pass; nothing
scrolls sideways at 400 px, 320 px or 200% zoom; no control is under 44 px or overlaps another
with a coarse pointer in any composition I built (links inside sentences aside, M3); reduced
motion removes every transition. What fails is what cannot be seen by looking at single states:
what the colour map does after a filter is undone, what the reserved chart height is on a phone,
and what happens to the second channel when direct labels do not fit, which is most of the time.

## How this was checked

- Built in place as instructed (`node tools/build.mjs && node tools/check.mjs && node
  tools/reference.mjs`). The generated files were byte-identical before and after (md5).
  Everything else ran on a copy in the session scratchpad.
- Rendered with Playwright (Chromium headless shell): the reference at 1500 and 400 px, both
  themes; my own chart page with 3, 8, 36 and 200 series, a 5-series page whose lines end close
  together, a 7-day backtest, at 1440 and 400 px, light and dark, greyscale; hover, keyboard
  crosshair (Home/End/Shift+Arrow), touch drag (CDP touch events, coarse pointer), Zoom in twice,
  legend toggles, Other expanded with two members picked, sort while the crosshair is set, and a
  filter round trip through the chart's own `setFilter`.
- My own compositions built from system classes only: a 6-panel dashboard (stats, three charts,
  a table, an error panel, a waiting panel with "Showing the previous query", a backtest); a
  monitor page (page head with state line, Acknowledge and "Silence…" with its menu, a failure
  notice under it, an agent banner, chart with threshold, interval and markers, timeline, key-value
  list, related links); an agent investigation report (claims with evidence charts, a rejected
  claim, ruled out, could not check, verdict, steps). Also the author's compositions re-rendered:
  dialog on its scrim, secret shown once, waiting, first run, the folded monitors table.
- Hit areas: my own `elementFromPoint` scan at 400 px with a coarse pointer, which (unlike
  `shots.mjs`) also measures links inside sentences, reports a control whose centre is taken by a
  neighbour instead of skipping it, and samples each control's drawn box for theft. Overflow and
  smallest text at 400, 320 and 200% zoom (720 CSS px at 2x).
- Colour: the colour-vision validator on both palettes against ground, sunken, raised, hover,
  rule and pressed, adjacent and `--pairs all`; WCAG ratios of every series on every surface; the
  luminance ratio between series (the greyscale question).
- Tools: `shots.mjs scenario reviews/system-v4/shots.json` and `states.json` run end to end;
  `speed.mjs fixtures/speed.json` (20 runs) and two further 20-run scenarios of my own, one with
  the harness's frame timing corrected; a first-load layout-shift test at 400 px with a coarse
  pointer; 16 mutants against `check.mjs`.
- Machine: 4 cores shared with other jobs, load average 12 to 17 during every speed run. Every
  speed number below is "measured here, on the system's fixture page, under that load".

Not checked: a screen reader by ear, Safari and Firefox, real touch hardware, enlarged text as
distinct from zoom.

## Images

Rendered here, in `review-images/`:

| File | Shows |
|---|---|
| `01-filter-round-trip-largest-series-in-other-light-1440.png` | 36 series after "without the three largest" and back: the three largest are in the grey band, slot 1 (blue) is the 9th largest, the readout says "highest: …b2d84 2.4 cores" while Other reads 0.0 to 2.8 |
| `02-phone-layout-shift-chart-reservation-400-coarse.png` | The fixture on a phone, scrolled to "CPU by pod" while data loads: reserved 534 px (dashed), drawn 820 px |
| `03-greyscale-no-second-channel-light-1440.png` | Greyscale: with direct labels (left) the routes read; without them (right) cart, auth and search are one grey in plot and legend |
| `04-five-close-series-no-labels-marker-words-dropped-light-1440.png` | Five routes ending within 41 ms of each other at full width: no direct labels at all; "Config change" and "Fired 13:07" are bare lines |
| `05-page-state-mark-orphaned-light-400.png` | A two-line page state at 400 px: the acknowledged mark sits alone above its words |
| `06-timeline-main-path-link-19px-coarse-400.png` | Measured touch areas in History: "Read the report" is 103 x 19 px |
| `07-two-picked-other-members-both-ink-light-1440.png` | Two members of Other picked: two identical ink lines, nothing says which is which |

## Finding by finding

`AR` is the app-restyle review (`AR-S` its "Changes the design system needs", `AR-PR` the PR's
proposed system changes), `FL` the flows review (`FL-S` its "System changes these screens need").

| Finding | Answer | Evidence |
|---|---|---|
| AR-M1 direct labels on the wrong line, colliding | **Fully** | Gutter labels with leader ticks land on their own lines (3 series, 1440); all-or-none on collision verified (image 04); none below 640 px. The cost, no second channel when they are absent, is M1 below. |
| AR-M2 colour assignment and Other | **Partly** | One band, one legend row, ranges, expand by 20, rank by window maximum: all present. A filter round trip puts the three largest series into Other and the readout names a smaller one as highest (B1, image 01). |
| AR-M4 touch cannot do what the pointer can | **Fully** | Touch drag moved the crosshair to 13:22 with no page scroll; Zoom in and Zoom out in the foot; a tap toggles a legend row; the readout is under the plot at 400 px. |
| AR-M5 long label sets hide what distinguishes them | **Fully** | Shared labels stated once, pod first, node dropped from every row when it does not fit, readout cut in the middle ("checkout-api-…9f8c6b5-3742c"); Last stays visible at 400 px. |
| AR-M6 pressed missing on three control types | **Fully** | `pressed` token, rendered rest/hover/pressed/focus for nine controls in both themes; press differs from hover (1.24:1 light, 1.20:1 dark) and from chosen. |
| AR-M7 units | **Partly** | Bare ticks, unit once at the top of the axis and in the legend head, one number format. No scaling rule in Chart and none in the reference chart: binary-round byte ticks and "k"/"M" exist only as Number prose (M2). |
| AR-M8 toolbar outranks the chart; reserved empty line | **Fully** for the waiting line (it lies over the strip; nothing reserved). The readout now reserves an empty line below 400 px of chart width (m4). |
| AR-S1 assignment algorithm | **Partly** | Stated, but rules 4 to 6 do not say whether series already folded into Other are "new"; the reference treats them as new and that produces B1. |
| AR-S2 Other | **Fully** | Token, band, one row, ranges, never a sum outside a stack. Two picked members are both `ink` (M2). |
| AR-S3 series contrast; series on ground, hover, raised in `check.mjs` | **Partly** | All nine reach 3:1 on ground, sunken and raised in both themes. Hover was answered by "never drawn there" plus a text guard on the swatch edge, which an override defeats (m9, mutant F). |
| AR-S4 quiet hover outranks active | **Fully** | Quiet press renders `pressed` (states sheet). |
| AR-S5 busy eases | **Fully** | `transition-duration: 0s` on `[aria-busy]`. |
| AR-S6 query well on touch | **Fully** | 44 px, body size. |
| AR-S7 direct-label placement and fallback | **Fully** | As AR-M1. |
| AR-S8 readout, brush, crosshair, narrow readout | **Fully** | Readout in the foot, own line below 400 px, brush `sunken` with `ink` edges. |
| AR-S9 waiting line reserved or overlaid | **Fully** | Overlaid on the strip; unit and ticks stay visible (my dashboard at 1440 and 400). |
| AR-S10 units in charts | **Partly** | As AR-M7. |
| AR-S11 author's items | **Fully** | Closed dialog hidden, mono inputs 44 px on touch, button menu rows reset, nav gutter, `vz-empty` padding, sortable head, checked menu row, `vz-qty`, scrim, skip link, "min", scenario states, TS length lint. |
| AR-S12 fixture and shared harness | **Partly** | Both exist and run. The harness never measures a phone layout (B2), adds up to a frame to toggle and response rows, measures typing during a background re-run, and the 200-series toggle is absent (M4). |
| AR-PR 1 to 9, and the eight "proposed additions" | **Fully** | Each present and rendered (dialog, mono input, menu rows, nav gutter, empty padding, waiting line, `shots.mjs`, `check.mjs`, "min"; readout, sortable head, checked row, Other, inline number, brush, scrim, skip link). |
| FL-B1 links 18–20 px on touch | **Partly** | Standalone links, key links and `vz-links` measure 44 px. A link inside a `p` stays text, and the system's own Timeline pattern puts the main-path link there: "Read the report" 103 x 19 px (M3, image 06). That is the "2 likely causes" link FL-B1 named. |
| FL-B2 hit areas overlap where rows wrap | **Fully** | `vz-controls`/`vz-stack`: 0 overlaps and 0 drawn-box thefts in all my compositions at 400 and 320 px. |
| FL-B5 series below, or unreadable without, colour | **Partly** | 3:1 met. Without direct labels (below 640 px, every small chart, any collision) the light slots 2–5 are one grey (luminance ratio 1.00–1.01) and all-pairs CVD fails (M1, image 03). |
| FL-M2 Silence unsafe at night | **Partly** | Yellow edge, toned buttons `space-6` apart, "Silence…" as a default button opening a menu of `menuitemradio`. Not specified: the after-state "Acknowledged by you at 15:16. Undo" / "Silenced until 16:16. End silence" (M6). |
| FL-M3 investigation reading order | **Fully** (system part) | Claim anatomy puts claim, evidence, then small verdict buttons that "change nothing else". |
| FL-M4 agent claims read as fact | **Fully** | Provenance line on every claim in `ink`, "Not verified", evidence query, ruled-out mark, `vz-agent`, "as the agent read it". |
| FL-M5 proposal not reviewable as a diff | **Fully** | `vz-changes`, per-change checkbox, before/after, warning with link, "Apply 2 changes", revision sentence. |
| FL-M6 charts miss the system's requirements | **Fully** | Ticks 0/250/500/750/1,000 with the threshold on one; "500 ms objective"; meta "09:16 to 15:16 · 6 min max"; axis ends at 15:16; markers. Dropped marker words are unrecoverable (m2). |
| FL-M10 Monitors loses its columns at 400 px and 200% zoom | **Partly** | 400 px: folded, Now and Threshold kept, everything else on a second line. 200% zoom (672 px of table width): no fold, table 972 px wide, Notifies and Investigation behind an unmarked sideways scroll (m7). |
| FL-S1 link and table touch targets | **Partly** | As FL-B1. |
| FL-S2 narrow form for tables | **Fully** at 400 px; see FL-M10 for 640 to 970 px. |
| FL-S3 wrapped control rows | **Fully** | As FL-B2. |
| FL-S4 chart component, second channel besides hue | **Partly** | Component complete; the second channel exists only where labels fit (M1). |
| FL-S5 action colours; `status-info` vs `blue` | **Fully** | `yellow-edge`, cautionary action behind a menu, `status-info` a cyan (`check.mjs` fails if equal, mutant E). |
| FL-S6 numbers in prose | **Fully** | `vz-qty`: 3.8 px before the unit, a 20 px line stays 20 px (measured; `vz-num` makes it 21). Cannot be used in a heading or the state line (m1). |
| FL-S7 missing components; literal 800 px breakpoint | **Partly** | All seven components exist. `vz-split` keeps a literal 800 px container breakpoint with a lint exemption (m11). |
| FL-S8 status vocabulary | **Fully** | Acknowledged, silenced, ruled out: neutral, shape plus word, distinct in greyscale. |
| FL-S9 rules to amend | **Fully** | Mixed-unit columns, banner link, stat window, page freshness. |
| FL-S10 review input | **Fully** | Method step 1 and `review.md` item 7. |

26 fully, 13 partly, none unanswered.

## Blockers

### B1. After a filter is undone, the largest series are grey and the readout names the wrong one

Rubric: Many series, "blocker if a colour or label names the wrong series". Rules: Chart, Series
colour 4 to 6; Colour, "a view hands out slots … largest first". Image `01`.

In the 36-series chart, filtering out the three largest pods and then clearing the filter (the
preview's own "Without the three largest" control does this on the 8-series chart; on 8 series
nothing is folded so the bug cannot show there) leaves:

- slots 1, 2, 3 held by the 9th, 10th and 11th largest (maxima 1.6, 1.6, 1.3 cores);
- the three largest (maxima 3.0, 2.9, 2.7) inside the Other band, which now reaches 2.8 at 12:04;
- the readout "12:04 highest: checkout-api-7d9f8c6b5-b2d84 2.4 cores", while the highest series at
  12:04 is in Other at 2.8;
- the legend note still "8 series are coloured, chosen by size when they first appeared", which
  is now false;
- the map in `sessionStorage`, so a reload keeps it for the rest of the tab's life.

Cause: `assignSeries` treats every series without a map entry as new, including the 28 already
present in Other, and gives them the reserved slots of the series the filter removed. When the
removed series return, no slot is free and rule 6 folds them. Rule 5 says a reserved slot is reused
only when "a new series needs a slot"; rules 4 and 6 do not say whether a folded series is new, so
the text permits this reading and the reference implements it. The readout's "highest" is computed
over coloured series only, so any state in which an Other member is the largest (this one, or a new
pod larger than all eight after a query edit) names the wrong series. AR-M2 rejected the app for
exactly this picture: "the three largest … are grey hairlines".

Fix: in the Chart rules and `assignSeries`, (1) a series already present in the view, folded or
not, is not new: it is promoted only into a slot that has never been held in this view, never into
a reserved one, so filtered-out series come back in their colours; (2) compute "highest" over every
drawn series and, when it is a member of Other, write "highest: Other, <name> 2.8 cores"; (3) when
an Other member exceeds every coloured series in the window, say so in the legend note ("1 series in
Other is larger than the coloured ones; choose it to draw it"), so the note stays true. Add the
round trip and the "new pod larger than all eight" case to the preview and to `shots.json`.

### B2. On a phone the chart's reserved height is 112 to 286 px short: layout shift 0.30

Rubric: Speed ("budgets met on the reference setup"), blocker. Rule: Responsiveness, "Layout shift
stays under 0.05: every region reserves its final size before its data arrives, including on first
load". Image `02`.

`.vz-chart[style*="--legend-rows"]` reserves `plot + control-sm + … + (rows + 1) × (control-sm +
hairline)`, the desktop geometry. With a coarse pointer the system itself makes legend rows
`control-touch + hairline` (45 px, not 25), the foot 44 px (not 24), and below 400 px of chart width
the readout takes its own line. On the fixture at 400 px with a coarse pointer, data delayed 800 ms:

| Chart | Reserved | Drawn |
|---|---|---|
| Latency by route (3) | 384 | 496 |
| Request rate (8) | 509 | 721 |
| CPU by pod (36) | 534 | 820 |
| CPU by pod, every namespace (200) | 534 | 820 |
| Backtest (`sm`) | 254 | 300 |

Desktop is exact (CLS 0 to 0.0003). On the phone, with the page scrolled to a chart before its
data arrives (what a browser does on reload), cumulative layout shift is 0.053 with the routes
chart in view,
0.062 with the request-rate chart and **0.301** with "CPU by pod": six times the budget. The harness
cannot see this: `speed.mjs` has one viewport per scenario, `fixtures/speed.json` uses 1440 x 900
with a fine pointer, so "a mid-range phone profile" is a CPU and network profile only.

Also under this row, measured here and not by the author: the legend toggle costs more with every
series, because the reference chart rebuilds the model, the Other band, every SVG path and every
fitted legend name on each toggle. Median over 20 runs: 54–58 ms at 3 series, 51–62 at 8, 76–78 at
36, **111–121 at 200**; 75th percentile at 200 series 140 and 177 ms in two runs. `speed.json`
measures the toggle at 36 series only, although the rubric asks for the 200 case.

Fix: put the legend row and foot heights into custom properties that the coarse-pointer block
overrides (`--legend-row: calc(var(--control-touch) + var(--hairline))`, `--chart-foot:
var(--control-touch)`) and use them in the reservation, plus one `small` line for the readout when
the chart is narrower than 400 px; give `speed.mjs` per-scenario `coarse` and a 400 x 800 viewport
and add a "load scrolled to a chart" layout-shift row. In the reference chart, a toggle changes
only what it changes: set `display` on the series' paths and the rows' attributes, recompute the
value axis only if the visible maximum changes, and never re-fit names or rebuild the Other band.
Add "Legend row toggle, 200 series" to `speed.json`.

## Majors

### M1. Where direct labels are not drawn, colour is the only channel, and the palette fails it

Rubric: Charts (major). Rules: Chart, Series colour 7, "Colour is never the only channel"; Colour,
"Shape and word carry the state; colour reinforces it" (applied to series by FL-B5). Images `03`,
`04`.

Direct labels are absent below 640 px of chart width (every phone, and every half-width panel on
a dashboard in a window narrower than about 1,350 px), in every `data-size="sm"` chart (backtests
and the evidence beside a claim) and whenever line ends lie too close to stack their labels within
two label heights (the 8-, 36- and 200-series fixtures, and five routes ending between 374 and
415 ms on a 1,392 px wide chart, image 04). In those charts the only link between a legend row and a line is hue:

- Greyscale: in light, slots 2, 3, 4 and 5 have the same luminance (ratios 1.00 to 1.01 to each
  other; the re-step put all four at 3.30–3.33:1 on white), and `series-8` equals `series-other`
  (1.00). In dark every pair of slots is within 1.28.
- Colour-vision validator, all pairs (lines cross, so any two slots can be neighbours; matching a
  legend swatch to a line is an all-pairs task): light worst deutan ΔE 1.8 (`series-2` / `series-4`),
  worst normal-vision ΔE 6.5 (`series-2` / `series-8`, floor 15); dark worst deutan ΔE 1.4
  (`series-2` / `series-6`), normal 7.1 (`series-2` / `series-8`). Adjacent pairs pass, as the
  author reported.
- "Sort by the last value so the legend's order matches the right edge" only orders the legend; the
  legend swatches are 12 x 4 px.

Fix, in order of value: (1) hovering, focusing or tapping a legend row emphasises its line (others
drawn in `series-other` until release), and the readout names the series nearest the pointer, not
only the highest; (2) give the slots a lightness stagger (alternate darker and lighter steps within
the band, so neighbouring slots differ by at least 1.3:1 in luminance) and re-run the validator
`--pairs all` until worst normal-vision ≥ 15; (3) if (2) cannot reach that with eight hues, colour
six and fold the rest, or give slots 5 to 8 a dash pattern and stop reserving dashes for thresholds
(thresholds are already labelled in words). Add a "second channel" question to the Charts row.

### M2. The Chart specification does not determine the chart

Rubric: Charts (major); the question this review was asked: would two engineers build the same
chart. They would not. Besides B1's open question (is a folded series "new"):

- Readout: "the highest series" over coloured series only (reference) or over all drawn ones (B1).
- Two or more members of Other picked: all are drawn in `ink` and cannot be told apart (image 07).
  The rule covers one.
- Sorting the legend while the crosshair is set: the head says "At 09:16" and shows values at 09:16,
  but the reference sorts by the last value (auth 517 is above search 658).
- Direct-label text: "fitted by the rule under Legend" (several labels, dropped until they fit), but
  the reference draws only the single most distinguishing label.
- Ticks: "three to five … one per 40 px of plot height at most" cannot both hold on a `plot-sm`
  plot (75 px); the reference draws five ticks 15 px apart.
- Units: no rule for scaling a raw value into a unit (bytes to MiB, binary-round ticks, "k"/"M");
  the reference draws whatever number it is given. Small values in Other show as "0.0" because one
  precision per chart is taken from the tick step.
- Zoom in "centred on the crosshair": not said what happens with no crosshair (the reference uses
  the middle).
- A dashboard panel "stores its map with the panel": not said whether a viewer's filter writes to
  the stored map for every viewer.
- Stacked charts are described (Other as the last band) but not specified or drawn.
- The chart's text form, which the rubric's Text form row and the marker rule ("every marker is in
  … the text form") rely on, is not specified at all.

Fix: answer each in the Chart README with one sentence, implement it in the preview, and add each
case to the preview so the "rules as code" functions cover it.

### M3. The system's own patterns put the main path inside a sentence, where it is 19 px on touch

Rubric: Touch. Rules: Controls, "the main path of a flow is never a link inside a sentence";
Every form factor, "a link inside a sentence is text and keeps its line". Image `06`.

The Timeline README and preview put the agent's "Read the report" inside the line's `p`; measured
with a coarse pointer it is 103 x 19 px (and "See the change" breaks across two lines, 19 px each).
This is the link FL-B1 named as the main path of the alert flow ("2 likely causes" in History) and
FL-M1 called "the most useful thing for someone woken up". Read literally the rubric makes it a
blocker; read with the README it is not a control at all. I have taken the README's side and
recorded it as a major, which is itself an example of M5.

Fix: Timeline: "a line may end with one link to what it describes; it is a standalone `vz-link`
after the `p`, not inside it", and change the preview. Say in the Touch row whether in-sentence
links are exempt and add the Controls sentence to the method's touch step.

### M4. The speed harness measures something close to, but not, what it claims

Rubric: Speed; Tools. Rule: Evidence, "Say what kind of number it is"; the harness header, "End of
the frame is taken as a task posted from requestAnimationFrame, which runs after that frame's
style, layout and paint".

- `z.until` calls `afterPaint` from inside a rAF callback, which schedules another rAF, so every
  `toggle` and `response` row ends one vsync later than the frame that showed the change. Fixed in
  a scratch copy, six of seven medians fell (by up to 11 ms) and one rose by 2: the bias is up to a
  frame by construction, and smaller than this machine's noise.
- After the `press` row the button's click starts a full re-run of all eight panels; the harness
  then waits for `body[data-loaded]`, which is already present, and 400 ms, so the typing row is
  measured while the dashboard redraws.
- No layout at phone width (B2) and no 200-series toggle.
- Nothing records machine load, and on this machine the 75th percentile does not reproduce: the
  36-series legend toggle measured 119, 87 and 116 ms in three 20-run sets within eight minutes
  (load 12 to 14), the seven-panel switch 109, 87 and 88 ms. A blocker row whose result depends on
  who else is using the machine cannot give the same verdict twice.

**Whose fault are the two rows the author reports over budget?**

| Row (author's p75) | Mine, three runs | Judgement |
|---|---|---|
| Charts to tables, seven panels (108 ms) | 109, 87, 88 ms p75; median 71–85 | **The fixture's and the machine's.** The fixture switches all seven panels, 210 table rows, in one input. Switching one 36-series panel: p75 61 and 83 ms, median 56. Over budget in one of three runs, by 9 ms, about the harness's own frame bias. |
| Legend row toggle, 36 series (131 ms) | 119, 87, 116 ms p75; median 76–78 | **The system's**: the reference chart rebuilds everything per toggle and the cost grows with series (B2's table). At 36 it is a coin toss on this machine; at 200, which the author did not measure, it is over at the median. |

Fix: post the message directly when `until` matches inside a rAF; wait for a counter to change after
`press` rather than for an attribute that already exists; record `os.loadavg()` and the number of
cores with every run and refuse to report a blocker row when load exceeds the cores (or run a fixed
calibration task first and print the ratio); add per-scenario viewport and coarse pointer.

### M5. The rubric still cannot give the same verdict twice

Rubric: System; the question this review was asked. Places where two careful reviewers would
disagree:

1. **Many series** asks "are the coloured series the largest", while Chart rule 3 forbids repainting
   survivors and rule 6 forbids promotion unless a slot is free: after any filter, range or query
   change a correct chart can fail the row.
2. **Many series** includes "are the budgets still met" at major; **Speed** makes the same failure a
   blocker.
3. **Touch** says "every control"; the rules exempt links inside sentences and also say the main
   path is never one (M3).
4. **Speed** depends on machine load (M4) and on a desktop-only layout (B2).
5. No row asks whether series can be told apart without hue. The flows reviewer recorded FL-B5 as a
   Contrast blocker; under v4's Contrast floors it passes, so the same chart is a blocker to one
   reviewer and a pass to another (M1).

Fix: resolve 1 by asking "were the coloured series the largest when they were assigned, and is any
series in Other now larger than every coloured one without the legend note saying so"; give each
failure one level; state the in-sentence exemption in the row; add "second channel" to the Charts
row and "layout shift at 400 px" to Narrow and zoom.

### M6. Gaps the flows will hit at once; the system's own previews already step outside it

Rubric: System ("uses only existing components and tokens"). Rule: Method, "No new component when
an existing one, composed, does the job".

The previews themselves need inline styles where a class is missing: the dialog's consequence
sentence (`style="margin:0;color:var(--ink-secondary)"` in Dialog and the dialog composition), the
sentence beside "Apply 2 changes" (Changes), a `small` secondary paragraph (Number), the notice's
distance under its control (`gap:8px` in Notice), a spacer pushing Settings right in the nav
(`style="flex:1"` in 8 of the 9 compositions). And missing for the flows:

- **After an action, with undo** (FL-M2): "Acknowledged by you at 15:16. Undo" replacing the
  button in place. The Claim has it ("replaced in place by Undo"); monitors do not.
- **Sections.** `vz-split` columns are a flat `space-4` stack, so a section heading sits as far
  from the content above as from its own (my report and monitor pages); the rule "`space-8` between
  sections" has no class.
- **Where a menu opens**, and what it is on a phone ("Silence…" at 400 px).
- **Empty or error at the plot's height** (Chart, States says so; nothing reserves it, so a chart
  that errors after drawing collapses its panel).
- **A time-range field with absolute times** (AR-m4: native "11/18/2026, 09:30:00 AM" inputs).
- **A row-actions trigger** with no icon set (FL-M9 asks for a row menu: Rename, Revoke key).

Fix: add `vz-dialog-text` (or a general `vz-text-secondary`), `vz-section` (heading plus content,
`space-3` inside, `space-8` between), a `vz-nav-end` spacer, a done-with-undo pattern in Button or
Status, a menu placement rule (anchored below its button; a bottom sheet under a coarse pointer
below 640 px), a plot-height reservation for `vz-empty` in a chart body, and a time-range field;
then remove every inline style from the previews.

## Minors

- **m1 Page state** (image 05): `.vz-page-state` is a wrapping flex row, so a two-line state puts
  the mark alone on its own line ("Acknowledged by Dana at 15:16, firing since 13:07 (2 h 9 min)" at
  400 px). The 8 px mark beside `heading` text is also small. `vz-qty` cannot be used there (it is a
  fixed 13 px and, as a flex item, opens gaps: "Firing since 13:07 ( 2 h 9 min )"), so times in the
  state line are sans while the Number rule says clock times are `vz-qty`. Fix: `display: block` with
  the mark inline, and let `vz-qty` take `font-size: 0.93em` outside `ui`.
- **m2 Markers**: words that collide are dropped "later ones first" and nothing can bring them back:
  hovering or keying to a bare line does not name it (image 04: "Config change 09:50" and "Fired
  13:07"). Name the marker in the readout when the crosshair is on it.
- **m3 Interval label** longer than its span is right-aligned to the plot edge and so starts left of
  the span, over the 13:02 marker line, at 400 px ("Firing since 13:07"); the rule says it never
  labels the time before the span. Shorten to "Firing" or move it above the plot.
- **m4 Readout line**: below 400 px of chart width an empty `small` line is reserved under the axis
  at rest (about 44 px of blank above the zoom buttons), the cost AR-M8 rejected for the waiting
  line. Put the zoom buttons on that line until the crosshair is set.
- **m5 Single series** gets a direct label in the gutter, repeating the title and costing 136 px of
  plot (my monitor page). No direct labels for one series.
- **m6 Cancel over the plot**: with a coarse pointer the waiting line's Cancel area reaches 13 px
  into the data area, so a tap on the top of the plot cancels the query.
- **m7 Fold**: folded state words are `small` `ink-secondary`, against "a word in `ink`" (the v1
  stat-context minor again); thresholds wrap inconsistently ("> 1% for / 10 min" against the
  README's "> 500 ms / for 5 min"); between 640 and about 970 px of table width a fold table does not
  fold and its right columns sit behind an unmarked scroll (Monitors at 200% zoom).
- **m8 Scrolling tables**: in a half-width dashboard panel the right column is cut mid-number with
  no edge or fade ("Requests, req/s" shows "2", "4", "5"), and a long key (no maximum width, no
  middle cut) pushes the figures off. Cap the key column and draw a hairline at a scrolling edge.
- **m9 `check.mjs` teeth**: of 16 mutants, 8 fail as they should, 7 survive and 1 misfires. Survive: an
  override `tr:hover .vz-swatch { box-shadow: none }` (the guard reads one source line, so the
  property it protects can be removed elsewhere); `ink-muted` on `pressed` and on `rule` in the
  legend (3.67:1, 4.19:1 text, both forbidden by the token notes); `series-8` set to
  `status-critical`; a `.vz-plot:hover` fill; literal `deg`, `%` and unitless values; any `scrim`.
  Misfires: moving the swatch's `box-shadow` to the next line fails the check.
- **m10 Fixture** breaks the rules it measures: its tables show 30 of 200 series with no
  `vz-table-caption`; every panel head says "· updated 12 s ago" before any data has arrived; the
  global Charts/Tables switch is not a control any screen has.
- **m11 Breakpoints**: `vz-split` adds a literal 800 px container breakpoint (FL-S7 asked for the
  system's 640); 640 and 1200 are also literals under `token-lint-ignore`. Record breakpoints in
  `tokens.json` and lint against them.
- **m12** The legend row's focus ring outlines the name cell, not the row it toggles.
- **m13** The readout is a polite live region updated on every pointer move. Announce only
  keyboard-driven moves, or after 500 ms of rest.
- **m14** `.vz-legend` (the v3 inline legend, a swatch without a ground edge) is still in the CSS
  and documented nowhere.
- **m15** Every table's rows become 45 px with a coarse pointer, including tables with nothing to
  tap. Scope it to rows that hold a link or control (`tr:has(a, button, input)`).
- **m16 Previews that teach the wrong thing**: Controls shows green "Acknowledge" beside yellow
  "Silence for 1 h" (Button: "Resolve" beside it), the pattern Controls forbids; the delete
  dialog's placeholder is the exact value to type and Delete is enabled before typing (v1 minor);
  the legend's "Show 8 of the other 8".
- **m17** `series-6` (#008300) and `series-8` (#e34948) are near-copies of `status-ok` (#0a8038,
  luminance ratio 1.02) and `status-critical` (#e0221b, 1.20) in light: a red line beside red
  critical marks. Not a token reuse, but the reading the rule wants to prevent.
- **m18 Still open from v1–v3**: the select arrow drawn with `linear-gradient` (the colour rules
  forbid gradients); `optimizeLegibility` and `antialiased`; untoned buttons at 600; the tab ring on
  the letters; the nav's last item scrolled out at 400 px; status in a stat context in
  `ink-secondary`; no gutter after a right-aligned column. The Cover's blocks of the four action
  colours (v1) is still there and is not on the author's open list.
- **m19** Secret at 400 px: "Hide" sits beside the key and "Copy key" drops below it. Put both
  buttons on their own row under the well.
- **m20 `shots.mjs` measure** skips links inside a `p`, skips the plot, and silently drops any
  control whose centre another control's area covers (`if (owner(cx, cy) !== el) continue`), which
  is the worst kind of overlap. So "0 under 44 px" cannot show M3, m6 or a fully covered control.
  Report those instead of skipping them.

## Questions asked of this review

1. **Each finding answered?** 26 fully, 13 partly, none not at all (table above).
2. **Would two engineers build the same chart?** No. Colour assignment after a filter (B1), the
   scope of "highest", several picked members, sorting with the crosshair set, the text of a
   direct label, ticks on small plots, unit scaling and the text form are each open (M2).
3. **Presence test of the new components.** PageHeader, KeyValue, Timeline, Claim (and `vz-agent`),
   Changes, Secret, Notice, FirstRun, the sortable head, the checked menu row, the disposition
   marks, `vz-controls`, `vz-stack`, `vz-table-caption`, `vz-panel-note` and `vz-links` each answer
   a question nothing else answers. Elements that fail it: the readout's empty reserved line (m4),
   the direct label on a single series (m5), the agent rule inside a banner that already has a mark
   (two marks for one sentence, see tells). Missing for the flows: M6.
4. **Regressions from v1–v3.** None of the v1–v3 blockers or majors has come back: no overflow,
   lint 0, contrast 240/240, tabs and nav 44 px or more, no tabular sans, the sticky column covers
   what scrolls under it with its hairline and hover (rendered at 400 px), the checkbox tick. One
   v1 minor recurs in a new place (status words in `ink-secondary`, m7).
5. **Is the rubric usable twice?** Not yet (M5).
6. **Generated-design tells.** Few in the interface. The ones that show: middle dots as the
   universal separator, which collide with marks ("confidence high · – Not verified", "Ruled out by
   the agent · – Not verified"); the agent's grey left rule stacked on a banner's mark and on a
   timeline's dash ("▬ |", "– |"), close to the "card with a coloured edge" the method bans; mono
   figures sprinkled through prose but not through headings, so the same "13:07" is sans in the
   state line and mono in the timeline; the ⌘↵ chip in the primary button and the Cover's colour
   blocks (both v1). In the documents: the roll-call of admired products and the aphoristic
   principle titles (v1), and a change log that maps finding ids more carefully than it tests the
   states between them.

## Measured here

**`check.mjs`**: contrast 240/240 pairings, literal values 0 in `src/components.css`. Run on
`project/components`, the previews carry 38 literal lengths in inline styles on 35 lines (mostly
demo widths; the rest are the gaps in M6).

**Validator** (`validate_palette.js`), light against `#ffffff` and `#f5f5f5`, dark against `#121212`,
`#0a0a0a` and `#1c1c1c`, adjacent pairs: all pass; worst CVD 9.0 light, 8.4 dark; worst normal 17.5
and 19.3. `--pairs all`: **fail** in both themes (M1). Against hover, rule and pressed (where series
are not supposed to be drawn): light slots 2–5 at 2.82–2.85, 2.60–2.62 and 2.27–2.29; dark all pass.

**Series contrast** (WCAG), light / dark, on the surfaces they are drawn on:

| | ground | sunken | raised |
|---|---|---|---|
| series-1 | 4.42 / 5.15 | 4.05 / 5.44 | 4.42 / 4.68 |
| series-2 | 3.33 / 4.82 | 3.06 / 5.10 | 3.33 / 4.39 |
| series-3 | 3.31 / 5.50 | 3.04 / 5.81 | 3.31 / 5.00 |
| series-4 | 3.30 / 6.10 | 3.03 / 6.45 | 3.30 / 5.55 |
| series-5 | 3.33 / 4.75 | 3.05 / 5.02 | 3.33 / 4.32 |
| series-6 | 4.95 / 5.58 | 4.54 / 5.90 | 4.95 / 5.08 |
| series-7 | 5.77 / 5.99 | 5.29 / 6.33 | 5.77 / 5.45 |
| series-8 | 3.95 / 5.80 | 3.63 / 6.13 | 3.95 / 5.28 |
| series-other | 3.95 / 4.36 | 3.62 / 4.61 | 3.95 / 3.97 |

Every other pairing I saw in the renders is in `check.mjs`'s list and passes (lowest text:
`ink-muted` on `hover`, 4.55 light / 4.68 dark; axis text `ink-muted` on ground 5.33 / 5.79).

**Hit areas, coarse pointer, 400 px**: my dashboard 57 controls, monitor 25, report 19, chart page
55 (at 320 px), the author's Monitors 19: none under 44 px, none overlapping, no drawn box taken by
a neighbour. Links inside sentences: monitor 2 (at 320 px, 103 x 19 and 102 x 19), reference 2
(103 x 19, 105 x 17). `shots.mjs` on the reference: 187 areas, 0 under 44 px. Cancel's area
reaches 13 px into a plot.

**Overflow and text**: 0 px sideways at 400, 320 and 200% zoom on every page I built, the reference
and the author's compositions; smallest text 11 px (`micro`).

**Reduced motion**: 146 elements with a transition on the reference; 0 with `reduce`.

**Inline number**: `vz-qty` keeps a 20 px `ui` line at 20 px (`vz-num` 21), 3.8 px before the unit;
in `body` text the figures are 13 px beside 15 px.

**Speed**, fixture page, 20 runs each, CPU 4x, Fast 4G, 1440 x 900, load 12–17 on 4 cores:

| Row | Budget | `speed.json` as shipped | My scenario, shipped harness | My scenario, corrected harness |
|---|---|---|---|---|
| Press: Run query | 50 | 28 (19, 53) | 21 (14, 129) | 22 (15, 44) |
| Typing (textarea) | 50 | 37 (23, 102) | | |
| Crosshair 3 / 36 / 200 | 50 | 30 / 33 / 35 | | |
| Legend toggle, 3 series | 100 | | 68 (58) | 63 (54) |
| Legend toggle, 8 series | 100 | | 81 (62) | 60 (51) |
| Legend toggle, 36 series | 100 | **119** (78, 223) | 87 (77) | **116** (76) |
| Legend toggle, 200 series | 100 | not measured | **140** (121) | **177** (111) |
| One panel (36) to table | 100 | | 61 (56) | 83 (56) |
| Charts to tables, seven panels | 100 | **109** (85, 148) | 87 (76) | 88 (71) |
| Tables to charts | 100 | 62 (54, 244) | 54 (44) | 55 (46) |
| Response to paint 36 / 200 | 100 | 43 / 39 | | |
| Layout shift, load and run, desktop | 0.05 | 0.0004 | | |
| Worst interaction | 200 | 200 (120, 504) | | |

p75 (median, worst) in ms. **Layout shift on first load, 400 px coarse, page scrolled to a chart:
0.053, 0.062, 0.301** (B2); desktop 0 to 0.0003.

**`check.mjs` mutants** (scratch copy): fail as they should: swatch edge removed, `pressed` = `hover`,
`series-4` back to `#eda100`, dot edge to `rule`, `status-info` = `blue`, two near-identical
neighbours, a literal `3px`, `series-other` near white. Survive: swatch edge overridden on hover,
`ink-muted` on `pressed`, `ink-muted` on `rule`, plot on `hover`, `series-8` = `status-critical`,
literal `deg`/`%`, opaque `scrim`. Misfire: swatch rule reformatted onto two lines.

## Keep

- The series rules' intent and most of their text: slots by rank at first sight, survivors never
  repainted, one Other band with ranges and one legend row, expandable; the legend as a table with
  shared labels stated once and the distinguishing label first, cut in the middle.
- The readout under the plot, the legend's "At 13:02" column, touch drag with Zoom in and Zoom out,
  one tab stop each for plot and legend with arrow keys, re-measuring names when the font arrives.
- Threshold, interval and marker words with a ground halo, drawn last; ticks that land on the
  threshold; time-axis ends labelled with the range's ends; gaps as gaps; step and aggregate in the
  meta.
- `pressed` as its own token, presses never eased, busy holding the fill.
- `vz-controls` and `vz-stack`: zero overlaps measured wherever I wrapped rows.
- The fold as the narrow form for lists read row by row, and `data-priority`.
- The waiting line over the strip, "Showing the previous query", and the chrome-belongs-to-the-data
  rule.
- `vz-qty`; Claim with its provenance line on every claim; the disposition marks; `status-info` as a
  cyan; Changes; Secret; Notice; FirstRun; PageHeader's wrap rule.
- The fixture and a shared harness at all, the scenario runner's `elementFromPoint` measurement, and
  the honest "not done" list in `CHANGES.md`.

## Housekeeping

Ran `tools/build.mjs`, `tools/check.mjs` and `tools/reference.mjs` in place; their outputs were
byte-identical to what was there. Everything else (`fixtures/build.mjs`, `shots.mjs`, `speed.mjs`,
mutants, my pages and the patched harness) ran on a copy in the session scratchpad and will not
survive it. Wrote only this file and `review-images/`. No Cloudflare, nothing under `flows/`. One
read-only `git status` was run by mistake at the end to confirm what had changed; nothing was
staged or committed. The servers and browsers I started are stopped.
