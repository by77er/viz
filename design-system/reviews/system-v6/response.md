# Design system v6: response to the v5 review

The input is `reviews/system-v5/review.md` (reject: B1, B2, M1 to M7, m1 to m15, 32 mutants of which 30
survived), the v4 review for history, the owner's direction, and, from the coordinator, the flow screens'
v5 revision (`flows/REVISION.md`, "v5": the overflow on screens 12 and 7, B1 on screen 5, the gaps G17 to
G27 and G11). Status: **not reviewed.** It needs an independent review under `project/review.md`.

v5 was rejected for problems that came back in new forms after v4's fixes. So for each finding this
response names the root cause, the change, and the automated check that would have caught it and now
guards it, and shows that check failing on v5 first. "Before" is v5 exactly as reviewed: a copy of
`design-system/` taken at the start of this session, before any edit (byte-identical `src/components.css`,
md5 `a17b9866…`), built by its own tools. Nothing outside `design-system/` was edited; `flows/`,
`reviews/system-v4/`, `reviews/system-v5/` and `app/` were not touched. Nothing was published.

## Blockers

### B1. Colour slots: a filtered-out series returned grey; a query edited and back greyed everything

**Root cause.** Not one clause but the shape of the rules: v5 assigned colours over what was *drawn*
(the chart filtered first, then called `assignSeries`), so a filtered-out series looked absent and its
slot could be handed to anything new; and an absent series' slot was given away *and its owner recorded
as Other*, so it could never come back. Rules 4 and 5 described two different algorithms, and the code
followed one of them.

**Change.** One algorithm, written once (Chart README, "Series colour", rules 2 to 7; the code comment in
`assignSeries` is the same text):

- A series is *there* when it is in the result **or when the view's own filter hides it** (a filter in
  the chart, or a label matcher a dashboard filter adds to the query): a filter hides a series, it does
  not remove it, so its slot stays held. Assignment runs over the result, before the filter.
- Each result: continuing series keep their colour; returning series keep the colour they had (Other if
  they were in Other; their slot if no series holds it now, the most recent holder winning a tie); new
  series, and returning ones whose slot another series holds, take by rank the lowest free slot, else the
  reserved slot whose holder has been away longest, else Other.
- The note about Other is counted over what the legend lists, with a sentence for "nothing coloured"
  ("No series is coloured: the 8 coloured are filtered out" / "are not in this result").
- "Colour the eight largest" restarts the map from what is drawn.

One decision with real alternatives sits inside this: whether a grey series still on screen may be
promoted when a slot frees up. It may not (survivors are never repainted), so a narrowing query edit can
leave only Other on screen; the note says why and offers "Colour the eight largest". The alternative
(promote) breaks the round trip: the promoted series would hold the slot when its owner returns.

**Guard.** `tools/test/chart-rules.test.mjs`, run by `npm test`, on the reference chart's own functions
(the one source of `dist/viz-chart.js`), without a page:

| Test | v5 (failing first, run on the v5 copy) | v6 |
|---|---|---|
| Image 01: filter out the three largest, a larger pod arrives, clear | **fails**: `checkout-api-…3742c` came back in slot 0 (Other), had 1 | passes: 3742c back in slot 1; the new pod in Other; note "1 in Other is now larger than a coloured series" |
| Image 02: query edited to search's pods and back | **fails**: `…b2d84` slot 0, had 4 (all 36 in Other) | passes: all eight back; note "8 coloured by size when first seen; 28 in Other" |
| Flow screen 5: one series, then 36 pods, then back (coordinator) | **fails**: cart came back grey | passes: cart back in slot 1 |
| A filter in the query (server side) with pods arriving meanwhile | **fails** | passes |
| 400 random sequences of 30 steps (arrive, leave, values move, filter in the chart, filter in the query, clear, edit and back, open Other, pick members, Colour the eight largest), checking P1 to P6 after every step | **fails** (P2 on the 1st sequence) | passes |

The properties checked after every step: P1 a series in two consecutive results keeps its colour; P2 a
filter cleared or a query edited back returns every series in its own colour; P3 a returning series
takes the colour it had, and a new one goes to Other only when all eight slots are held, never grey while
a smaller placed series is coloured; P4 "highest" is the highest of every drawn series, Other's members
included; P5 the text form's threshold lines, Other line and note are computed over every drawn series;
P6 the note's counts are the legend's and "larger than a coloured series" needs one. The property test
found one ambiguity while I wrote the code: a series that had been in Other came back *coloured* after a
query round trip (it took a slot reserved for a departed series). The rule now says a returning series
keeps the colour it had.

**Teeth.** Chart mutants C1 to C9 in the corpus, each caught by this test: v5's order (filter before
assignment), a returning Other member taking a slot, a returning series never getting its slot back, new
series never taking a reserved slot, "highest" over coloured lines only, the threshold over coloured
lines only, the note counted over the result, a lost minus sign, an axis pinned at zero.

**Images.** `compare/v6-b1-filter-new-pod-clear-*` and `compare/v6-b1-query-edit-and-back-*`: the
reviewer's two sequences played on the Chart preview, v5 on the left (3742c grey in Other; one grey band),
v6 on the right.

### B2. The Table patterns scrolled sideways at 400 px and 200% zoom

**Root cause.** Two pattern-level gaps, not one line. (1) A scrolling or clipping box that is not a
containing block lets anything absolutely placed inside it escape: `.vz-table-wrap` scrolled but was
not positioned, so the visually hidden "Actions" head widened the page. (2) The fold pattern had no
rule for content wider than a kept column (a status could not wrap; a phrase could be wider than
`keep`), no place for the row's actions (`width: 0`), and nothing said a folding table must not scroll.

**Change.**

- `.vz-table-wrap { position: relative }`: what is placed inside is clipped by its scroll.
- In both fold forms: a kept column is `keep` wide but never narrower than its longest unbreakable phrase
  (`min-width: min-content`); a state in it wraps between words, its mark centred on the first line
  (`.vz-status` aligns its mark to the first line everywhere, so this is the same picture for one line);
  `td.vz-row-actions` ends the key's line in every row (order 1, its own width), so "Actions…" is always
  on screen with its hit area inside the row (also flows G20, G26); no gutter after a right-aligned
  column once folded (flows G21).
- The narrow and wide fold forms are one pattern: every folding rule now has its `data-fold="wide"`
  twin, including Waterfall's and Log's, which had none.
- The rule: **a folding table never scrolls sideways**; one whose columns do not fit 640 px is
  `data-fold="wide"` (Table README; the dialog composition's list, Log and Waterfall now are).

**Guard.**

- `tools/audit.mjs` (new): every preview as a page, `dist/reference.html`, the fixture, the compositions
  and the flow screens, at 320, 400, 560, 640, 800, 1024, 1280 and 1500 px fine, 320, 400 and 768 px
  coarse, and 200% zoom of 1280, 1440 and 1500 px windows. It fails on a page that scrolls sideways
  (naming what sticks out), anything absolutely placed inside a clipping box whose containing block is
  outside it, a head or cell outside its table, a folding table that scrolls, a word cut by a clipping
  edge or out of view (outside strips that scroll on purpose and text cut on purpose with an ellipsis),
  and text below micro. Run on v5 first (quick set: 320 and 400 coarse, 720 at 200%, 1500): **126
  findings**, among them every image of B2: the Table preview 249 / 169 px wider than the window at 320 /
  400 (image 03), `dist/reference.html` 177 px at 400, the dialog composition 38 px at 200% (image 05)
  with the `vz-sr` head named as escaping, "budget" of "Burning budget" and "Actions…" cut at 400 coarse
  (image 04), plus what the review did not list: the Monitors fold table in the Table preview and the
  reference scrolling 7 to 11 px at 320 ("Threshold", "10 min" cut), the secret composition's keys table
  scrolling 102 px at 320 with "Never, created just now" cut, Log and Waterfall folding tables scrolling
  6 to 47 px at 200% zoom and at 1500 (m15), and the Cover preview 640 px wider (m13).
- `check.mjs` structure: the wrap is positioned; the kept column's status wraps and has its minimum
  width; the actions cell has its place; the fold forms are twins (mutants V1, V2, V3, V4, V15).
- Corpus A1 to A3: the audit itself catches the escaping head, the cut state and the cut "Actions…" when
  each fix is removed.

<!-- AUDIT-RESULT -->

## Majors

### M1. The text form left out members of Other

**Root cause.** The text form was written separately from the picture (its own loop over `m.coloured`),
so it could drift from what the legend note and the readout computed. **Change.** One computation for
the readout, the note and the text form: `chartFacts(model, drawnSet, spec)` returns the drawn set
(lines, picked members, the band's members), the highest at any point, the series above the threshold
at the end and earlier, Other's highest member and the note; `textLines` turns those facts into
sentences and the page only prints them. The text form now says, for image 06's state: "3.5 cores limit.
Above it at 15:16: Other, checkout-api-7d9f8c6b5-new01 (…). Above it earlier in the range but not at
15:16: …", carries the note's sentence word for word and names Other's highest member. **Guard.**
Properties P4 to P6 in `chart-rules.test.mjs` compare every fact against a brute-force computation over
every drawn series after every step of 400 random sequences, and require the note and the threshold's
names to appear in the text form; the image-06 case is a fixed test (fails on v5: there is no text form
outside a page; v5's own function tested only coloured series). Mutants C5, C6 and C7 (facts over
coloured lines only, the note over the result) are caught. **Image.** `images/v6-limit-text-form-*`:
the Chart preview's new "CPU by pod, against the limit" panel with its text form open.

### M2. The Chart specification had open places

Each now has one sentence in the Chart README, a case in the preview, and a test:

| Open place | The rule now | Test |
|---|---|---|
| Reserved slots (rules 4 and 5 disagreed) | One algorithm (B1) | B1's tests and properties |
| Values below zero | The axis holds zero, every drawn value and the threshold; it runs from the lowest value when that is below zero; zero is a tick in `rule-control`; nothing is drawn outside the plot. A panel may start above zero only down to its lowest value | `valueTicks` cases (−120 to 120; all positive from zero; all negative up to zero); mutant C9; preview panel "Request rate, change on last week"; `compare/v6-m2-values-below-zero-*` |
| "Which series are above it" | Over every drawn series, Other's members included; "above" is strictly greater; two facts, at the end and earlier in the range | P5; image-06 case |
| Precision at a 2.5 step | One decimal place more than the place of the step's leading digit (250 and 200: whole; 2.5, 2, 1: tenths; 0.25: hundredths), never fewer than the ticks | `numberFormat(2.5).value(7.4321) === '7.4'` and four more (the code already did this; the sentence had two readings) |
| A small negative value lost its sign | A minus sign (U+2212) on every negative; a small one prints "> −0.1" | four cases; mutant C8 |
| Unsaved series in a panel's map | Each viewer's copy places a series that appeared after the last save at that viewer's first sight, so viewers can differ for it until an editor saves; the stored map's series are the same for everyone | the rule only (no stored-map code exists in the system) |
| The threshold inflated the axis (m6) | Nothing is added for the threshold's label; its label goes under the line when above would reach the strip | `valueTicks` case: data to 4.0 with a 3.5 threshold tops at 4, not 6 |

### M3. The speed harness could not judge the budgets it exists for

**Changes to `tools/speed.mjs` and the fixture.**

- **A finger's press is a finger's.** On the phone layout every press is CDP touch events (`touchStart`
  held, then `touchEnd`) and every toggle, menu, theme, view and run is a tap. A press is judged by the
  fill actually painted: from `pointerdown`, the first frame in which the control's background differs
  from its rest fill (a press never painted within 1 s counts 1000 ms). This is what showed the
  reviewer's finding as a number: v5's Run button, pressed by a held finger, **never** paints (1000 ms in
  every run); v6 paints it from `pointerdown` through `viz-press.js` and the `[data-pressed]` twin of
  every `:active` rule (`check.mjs` fails if any `:active` has no twin; mutant V5).
- **Every budget row is measured**: added "Open a menu (Share…)", "Change theme (to dark)", "Move to a
  view whose data is not loaded: its shell and waiting state" (the fixture has a second view, Pods, whose
  data loads when it opens; its shell, panel, caption strip and reserved table appear at once, the link is
  busy until 400 ms, then a waiting line with the stage and elapsed time) and "Run a query: request sent
  and waiting state shown" (a new `send` row: counted only once the request has left). Both scenarios.
- **Before and after alternate in one session**: `--compare <before page>` runs before, after, before,
  after…, each from a fresh browser context, so both share the machine's load; both shipped scenarios
  (`speed.json`, `speed-phone.json`), not trimmed copies.
- **Load next to every number, one rule**: every sample records the 1-minute load average when it was
  taken; the table prints the median and range of the load beside every row; a timing row is judged only
  when most of its samples were taken at a load at or below the core count, stated in the output. The
  calibration ratio is printed as context and judges nothing (M4.2).

<!-- SPEED-RESULT -->

### M4. The rubric gave two verdicts in four places

| Place | One reading now |
|---|---|
| Charts: told apart without hue | Lines in different dash groups differ by dash; neighbours by the lightness step (1.3:1); lines that share both (1 and 3, 2 and 4, 5 and 7, 6 and 8) are told apart by a direct label, emphasis from the legend or the readout's name; a greyscale image in which two such lines look alike does not fail the row if those three work |
| Speed and load | A timing row is judged only when most of its samples were taken at a load at or below the core count; otherwise neither passed nor failed, whatever the calibration ratio. The rules' "or with the calibration ratio stated" is gone, so rules and rubric say the same |
| Type: numbers in mono, right-aligned | The row names the three exceptions the Type rules give and no others (a `vz-stat` in the sans; a mixed-unit column left-aligned; `vz-qty` in prose) |
| Tokens: `check.mjs` passes | The property is the absence of literals (the exceptions listed in `tools/lib/lint.mjs`); `check.mjs` finds them, and a literal it misses is still the row's failure |

Read again for other double readings: the Many series row now states the algorithm's guarantee (a
series on screen keeps its colour; a filter cleared or a query edited back returns every colour) and
names both blocker cases (a series hidden by a filter returning grey; a series returning grey while no
series on screen holds its slot), and asks for the note's "nothing coloured" sentence.

### M5. `check.mjs` passed literal values it says it rejects

**Root cause.** The lint read text with regular expressions written for the values the author expected
(lower-case units from a list, functions by lower-case name, `style` only in double quotes, a 50%
exemption anywhere, conditions stripped before linting), and the structural checks covered only the fixes
somebody remembered to add a check for.

**Change.** `check.mjs` now parses: **css-tree** for every piece of CSS (component CSS, `<style>`,
`style` attributes in either quote, CSS written by script through `style="…"` in templates, `cssText`,
`style.<prop> =` and `setProperty`) and **parse5** for HTML; both are exact-version npm dev dependencies
(`css-tree` 3.2.1, MIT; `parse5` 8.0.1, MIT; nothing vendored, so `THIRD_PARTY.md` is unchanged). Every
value is walked at every depth (inside `calc()`, `var()` fallbacks, colour functions, gradients,
filters and conditions), and anything that is a design value is reported by kind: colour (hex, named and
system colours, any colour function in any case, `color-mix` of tokens), length/duration/angle in any
unit and case, percentage outside geometry, non-integer number (off-scale arithmetic), weight (numbers
and keywords), size (keywords, or anything but a type token for `font-size`), typeface, italic, capitals,
tracking, radius (only radius tokens), shadow (a blurred layer that is not `shadow-overlay`), filter,
opacity, blend, easing (keywords and functions; `linear` only on a scroll timeline), breakpoint (any unit
other than px, any px that is not a breakpoint token), and hover rules that do anything but recolour.
The exceptions are written at the top of `tools/lib/lint.mjs` with their reasons. Structure
(`tools/lib/structure.mjs`): colour confined to toned buttons, status marks, chart series and the focus
ring; `shadow-overlay` on overlays only; presses never eased and every `:active` with its `[data-pressed]`
twin; and **presence checks for every fix of v4, v5 and v6** (focus ring and the rings drawn by cells,
coarse hit areas for 15 controls and table rows, the chart's reservation from the coarse sizes and never
keyed on a `style` attribute, dashed slots and swatches, emphasis, `touch-action`, reduced motion, the
swatch ring, the dot edge, the error state's hollow swatches, the positioned table wrap and its scroll
edge, the fold pattern and its two forms in step, the caption as one run, the status mark on the first
line, links in running text, a cut link's underline). New token checks: disabled ink apart from muted ink,
Other apart in lightness from every slot, micro the smallest type. The rendered audit adds a finger's
press (`[data-pressed]`) and, at both pointers, reserved against drawn height for every chart that reserves.

**The corpus.** `tools/mutants-corpus.mjs` holds the reviewer's 32 mutants as X1 to X32 (each written
from the review's description; several plant more than one literal, and each must be reported), with
v4's R1 to R18, v5's N1 to N13, v6's V1 to V16, chart-rule mutants C1 to C9, page-audit mutants A1 to A4
and harmless edits H1 to H4. `npm test` runs it (`tools/test/check.test.mjs`; `VIZ_SLOW=1` adds the
mutants that need a browser); `tools/mutants.mjs` prints it as a table. Every mutant is applied to a copy
outside the tree (the runner refuses a directory inside it).

<!-- CORPUS-RESULT -->

### M6. The dashboard composition's figures disagreed

**Root cause.** The composition's figures were typed by hand beside charts that compute theirs, and
nothing compared them. **Change.** One sheet of numbers: the stats and the table read what the charts
draw (the routes chart's last p99 for POST /v2/orders, 912 ms; the request-rate chart's last value for
checkout-api, 1,087 req/s), the table is "Slowest routes of checkout-api" (no route of another service
under a checkout-api chart), its p99 column is the chart's last value for the three routes the chart
draws, its window is the chart's last step ("the 6 min to 15:16"), its six routes' requests add up to less
than the service's total (946.5 of 1,087 req/s), and the stat labels say whose figure each is ("p99 of POST
/v2/orders", "Errors on POST /v2/orders"), not the dashboard's. The waiting state moved to the 200-series
panel, so the chart the Requests stat is read from is current. The fixture's stats were made to agree with
its charts the same way (m10's middle dots went with them). **Guard.** Figures that come from a chart
carry `data-figure="<chart>|<series>|last"` and figures shown twice `data-same`; `tools/audit.mjs`
compares each with the chart's own model (`vz.figures()`) at 1500 px on every composition and the
fixture. On v5's composition the same marks would have reported the three disagreements the review lists.

### M7. The dashboards list hid that it was partial, and its order and ages were wrong

**Change.** "3 of 12 dashboards, most recently changed first", in that order, with dates and times beyond a
day ("15 Nov, 10:42, by Sam"). **Guard.** `tools/audit.mjs` on every composition: a caption's first number
must be the number of rows under it; "most recently … first", "slowest first" and "highest … first" must
match the rows' order; an age beyond a day must be a date and time. On v5's dialog composition it
reports all three ("12 dashboards …" over 3 rows; "3 d ago" after "12 d ago"; "12 d ago" and "3 d ago"
as ages). It also found one in v5's traces composition ("13 spans …, 10 shown" over 10 rows), now
"10 of 13 spans, in the order they started", in the composition and the Waterfall preview.

<!-- SECTIONS -->
