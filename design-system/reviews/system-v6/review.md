# Review: viz design system, v6

Reviewed 2026-11-19 against `project/review.md` (v6's), by the reviewer who rejected v5 and who was not
given the author's reasoning. Inputs: the system on disk, the compositions in `compositions/`, the flow
screens in `design-system/flows/`, and my own v5 findings. `response.md` was read only after every finding below was
written, to check its claims (last section); `evidence/` was not read. Every image cited is in
`review-images/` and was rendered here.

## Verdict: reject

Two blockers and one major. The rubric: "Reject: any blocker, or three or more majors." B1 is a
plain failure of the folded list on a phone. B2 is narrow and comes from the rubric and the Chart README
disagreeing; the rubric makes it a blocker and only a second reviewer may waive one. Without B2 the
verdict would still be reject.

v6 answers almost everything v5 was rejected for, and answers it properly: both v5 colour sequences
now return every series in its own colour (and the algorithm is written down and tested as
properties); no page scrolls sideways at any width from 320 to 1500 px, at 200% zoom, with either
pointer (53 pages, 12 configurations); a folded list wraps its state and keeps "Actions…" on screen;
the text form includes Other; values below zero stay on the plot; a finger's press paints at once;
every budget row has a measurement; the rubric's four ambiguities are resolved; all 32 of my v5
mutants are now caught; the worked examples agree with themselves.

What fails:

- **B1.** v6's fix for the folded list (row actions on the key's line, kept columns at least their
  longest phrase) leaves the key what is left. With a realistic key, a pod name holding the system's own
  middle cut, every key in a 40-row list overruns its cell at 320 to 480 px and is drawn over the kept
  figures, and the part of the name drawn over them is not the link (image `01`). With monitor names it
  wraps to five lines in a 75 px column (`02`).
- **B2.** Two sequences still end with a series grey in the ways the Many series row names as
  blockers. Both follow rules the Chart README states on purpose, so the README and the rubric disagree
  (node, on the chart's own functions).

## How this was checked

- A copy of `design-system/` in the session scratchpad. `npm run build` there reproduces `dist/viz.css`,
  `tokens.css`, `viz-chart.js`, `bundle.css` and `reference.html` byte for byte; `dist/fixture/index.html`
  does not (the copy on disk predates the last CSS change: minor m6).
- `tools/check.mjs` on the copy: contrast and structure 770/770, rendered audit 0 failures, reserved
  heights 490.5/490.5 (fine) and 711.5/711.5 (coarse), 0 literals; 76 s at load 13.
- 52 mutants of `check.mjs` on copies (never in place): my 32 from v5, adapted where v6 reworded the
  text they edit, and 20 new ones aimed at the rebuilt check (css-tree, parse5, the presence rules).
- The Chart rules driven in node through the chart's own functions (`vzChartRules`, loaded from the
  preview as the author's tests load it): seven sequences of my own. The two v5 sequences, the
  none-coloured note, reloads and `setData` also on the running preview page.
- Overflow sweep: the ten compositions, the twelve flow screens (`flows/dist`, which load v6's
  `dist/viz.css`), the 30 preview pages and the reference, each at 320, 360, 400, 480, 600 and 768 px
  with a coarse pointer and touch, 1024, 1200, 1440 and 1500 px with a fine pointer, and 720 and 750 CSS
  px at 2x (200% zoom): 636 loads. For each, the page's sideways overflow and any `data-fold` table that
  still scrolls, with what it hides.
- Compositions: all ten, my firing-monitor page from v5 (unchanged), and flow screens 1, 4, 7, 8 and 12,
  both themes at 1500 px fine and 400 px coarse; hit areas by `elementFromPoint` at 400 px coarse (480
  controls). Keyboard walks with a ring check on every stop; reduced motion.
- A finger's press (CDP touch, held), a mouse press and a scroll that starts on a button, on the fixture.
- `tools/speed.mjs fixtures/speed-phone.json --runs 3`.
- Machine: 4 cores shared with other sessions; 1-minute load 8.6 to 14.3 throughout, 12.4 to 14.0 during
  the speed run (calibration 679 ms against about 100 ms idle). **No timing here can be judged.**

Not checked: a screen reader by ear, Safari and Firefox, real touch hardware, enlarged text as distinct
from zoom, `tools/audit.mjs`, `tools/mutants.mjs` and `check.test.mjs` end to end (I measured their
subject matter my own way; `chart-rules.test.mjs` ran here, 10 of 10).

## Images

| File | Shows |
|---|---|
| `01-folded-list-key-drawn-over-figures-light-400-coarse.png` | A 40-pod folded list (`data-fold="wide"`, key links with `vz-cut`, CPU and Throttled kept, row actions): each pod name runs out of its 87 px cell across the CPU figures |
| `02-folded-monitors-key-squeezed-to-five-lines-light-400-coarse.png` | The Table preview's own Monitors fold with a row-actions column and real monitor names: the name wraps to five lines in a 75 px column |
| `03-v5-b1-filter-new-pod-clear-fixed-light-1200.png` | v5's first sequence on the preview page: the three largest back in slots 1 to 3, the new pod in Other with the note |
| `04-none-coloured-note-light-1200.png` | A filter hiding all eight coloured series: "No series is coloured: the 8 coloured are filtered out" |
| `05-values-below-zero-axis-holds-them-light-1200.png` | Values from −120 to 120: ticks −200 to 200, every line inside the plot |
| `06-v5-b2-folded-list-state-wraps-actions-on-key-line-400-coarse.png` | v5's image 04, now: "Burning budget" wraps, "Actions…" on the key's line, "3 of 12 dashboards", dates absolute |
| `07-v5-m1-links-in-sentences-keep-their-line-400-coarse.png` | A link in a list sentence keeps its line |
| `08-…firing-light-1500.png`, `09-…firing-dark-400-coarse.png` | My composition, full page, as v6 renders it |
| `10-dashboard-dark-400-coarse.png` | The dashboard composition as rendered here |
| `11-flow-12-routes-200pct-zoom-fold-scrolls.png` | Flow screen 12 at 200% zoom: a `data-fold` table that does not fold, "Why" and "End silence" behind its scroll |

## My v5 findings, checked

| v5 | Now | Evidence |
|---|---|---|
| B1 filtered-out series return grey; query round trip greys everything | **Fixed** for both sequences | Node, chart's own functions: filter the three largest, a pod larger than all arrives, clear: slots 1 to 3 return, the new pod in Other with "1 in Other is now larger than a coloured series". Query edited to another service and back, twice: every slot returns. Also fixed: deploy churn and rollback, a server-side filter with a pod arriving, a range in which the three largest have no data. On the page: the same, through a reload (image `03`), and the none-coloured note (`04`). Two narrower sequences remain: **B2**. |
| B2 sideways scroll (Table preview 169 px, reference 177 px, dialog 38 px at 200%; folded list cut) | **Fixed** in the system | 0 px page overflow in all 636 loads, including every flow screen. `.vz-table-wrap` is positioned. The dialog composition's list at 400 px: state wraps, "Actions…" on the key's line (`06`). But the same fix squeezes the key: **B1**. Three flow screens, still v5 markup, scroll a `data-fold` table at 200% zoom ("The flow screens", below). |
| M1 text form leaves out Other | **Fixed** | "3.5 cores limit. Above it at 15:16: Other, checkout-api-7d9f8c6b5-new01 · node-b · checkout-api (4.0). Above it earlier in the range but not at 15:16: none." The note's sentence is in the text form. |
| M2 Chart spec open | **Fixed** | Rules 4 and 5 replaced by one algorithm with its consequences; values below zero extend the axis (`05`); "above" split into at the end and earlier, over every drawn series; precision defined by the step's leading digit (7.4321 at a 2.5 step → "7.4", as the rule now says); "> −0.1" for a small negative value; unsaved series in a panel map stated. New open point: the tie when several reserved slots were vacated in the same result is broken by slot number in the code and not in the text (minor m1). |
| M3 harness | **Fixed**, Speed row still open | Presses by touch on the phone layout, measured by the painted fill; menu, theme, query sent and view change rows added; load per sample; calibration context only. Finger held on Run: pressed fill in 7 to 21 ms (6 presses; v5: never). No row can be judged at this load (below). |
| M4 rubric two readings | **Fixed** | Charts names the shared-step pairs and what tells them apart; Speed: judged only at load ≤ cores, "whatever the calibration ratio"; Type lists its three exceptions; Tokens: "a literal it misses is still this row's failure". One new conflict: **B2**. |
| M5 `check.mjs` passes literals | **Fixed** for all 32 | Every one of my v5 mutants is now caught, most with a message naming the v5 finding. 18 of 20 new ones survive: **M1**. |
| M6 dashboard figures disagree | **Fixed** | "Requests to checkout-api 1,087", "Errors on POST /v2/orders 2.41", "p99 of POST /v2/orders 912"; the table's p99 315 and 117 are the chart's last values; every route is checkout-api's. |
| M7 list caption, order, ages | **Fixed** | "3 of 12 dashboards, most recently changed first"; 15 Nov, 6 Nov, 2 Oct, each with a time (`06`). |

My v5 minors: m1 links in sentences (fixed, `07`); m2 cut links' underline (fixed); m3 error after
draw (swatches now hollow; the 130 px blank stays, by decision); m4 done state (fixed: the state line
keeps its words and takes the mark); m5 `series-other` against slots (fixed: 1.30 to 1.47 light, 1.16 to
1.25 dark); m6 threshold axis (fixed: "nothing is added for the threshold's label"); m7 reservation keyed
on `style` (fixed, and guarded); m8 nav at 400 px (now a scrolling strip with an edge); m9, m10, m11
(fixed in the previews); m12 (`shots.mjs` classification) not re-checked; m13 Cover (left out of my sweep, not re-checked); m14 table scroll edge (fixed: a border on a scroll timeline, seen at 400 px); m15 Logs at 200%
(the composition's Logs list folds wide now).

## Blockers

### B1. In a folded list the key is squeezed to what is left, and a long key is drawn over the figures

Rubric: Touch, "does every control have a 44px hit area with no overlap"; Narrow and zoom (the kept
columns are what the list exists for). Rules: Table, Fold ("its key and its one or two priority columns
stay as columns"; "a long identifier is cut in the middle with `vz-cut`"); Every form factor. Images
`01`, `02`.

v6 puts "Actions…" on the key's line and gives each kept column at least its longest phrase. Both are
right on their own; together the key gets the remainder, and nothing gives it a minimum or lets its
middle cut engage. Measured on my v5 composition, unchanged (a 40-pod `data-fold="wide"` list: key link
with `vz-cut`, CPU and Throttled kept, row actions, all as the Table and Menu READMEs describe):

| Width | Keys overrunning their cell | Key cell / name drawn | Drawn over |
|---|---|---|---|
| 320 px | 40 of 40 | 49 / 215 px | the CPU and Throttled figures and "Actions…" |
| 360 px | 40 of 40 | 68 / 215 px | CPU and Throttled |
| 400 px | 40 of 40 | 87 / 215 px | CPU and Throttled |
| 480 px | 40 of 40 | 126 / 215 px | CPU |
| 600 px | 16 of 40 | 183 / 215 px | CPU |
| 900 px | 26 of 40 | 173 / 215 px | CPU |

At the name's centre, outside its 44 px cell, the link is a target only 20.8 px tall; further right,
over the figures, `elementFromPoint` finds the figure's cell, not the link. So part of the visible name
is not a target at all, and the figures under it cannot be read (`01`). In v5 the same
page kept every name whole on the key's line. With words instead of identifiers, the Table preview's own
Monitors fold, given a row-actions column and names as long as real ones ("checkout-api p99 latency,
POST /v2/orders"), sets the name in a 75 px column over five lines (`02`). The author's compositions do
not show it because none of them folds a list with long keys and kept columns and row actions.

Fix: give the key a minimum (the cut's two ends, or half the row), let its `vz-cut` shrink inside a
link (`min-width: 0` down the chain), and when key, kept columns and actions do not fit, move the
actions to the folded line's end rather than taking the key's room. Add a list like `01` to the
compositions and to `tools/audit.mjs`, which already fails "a word cut by an edge" and could fail a cell
whose content overruns it.

### B2. Two sequences still end with a series grey in the ways the Many series row names

Rubric: Many series, "blocker if a colour or a label names the wrong series (… a series hidden by a
filter returning grey, a series returning grey while no series on screen holds its slot)". Rules: Chart,
"The algorithm" 3 and 5. Measured in node on the chart's own `chartModel`, `assignSeries` and
`recolour`, 36 series:

| Sequence | Result | The rubric's words |
|---|---|---|
| **D.** The largest pod (…3742c, slot 1) is missing from one result while a new pod (new01) arrives; the person filters new01 out; …3742c comes back | …3742c returns **grey, in Other**. Slot 1 is held by new01, which the filter hides: nothing on screen is drawn in slot 1. Note: "1 in Other is now larger than a coloured series". | "a series returning grey while no series on screen holds its slot" |
| **E.** "Without the three largest"; a new pod arrives and the note offers "Colour the eight largest"; the person presses it; clears the filter | The three largest (…3742c, …6ff93, …99ff1) return **grey, in Other**; slots 1 to 8 went to the eight largest of what was visible. Note: "3 in Other are now larger than a coloured series". | "a series hidden by a filter returning grey" |

Both are what the README says should happen. D: a slot is "held" by a series that is *there*, and a
series a filter hides is there; the rubric says "on screen". E: rule 5, "the eight largest of what is
drawn take slots 1 to 8 … series hidden by the filter are placed when they return"; placed, with all
eight slots held, means Other. So the two documents give two verdicts on the same chart, and as written
the rubric's verdict is blocker. Both sequences are narrow (D needs a pod gone for exactly one result
while another arrives, then a filter on the newcomer), which is why a second reviewer may well waive
them; I cannot.

Fix: D, make the rubric say "no series that is there" (the algorithm's choice is sound: giving the slot
back would collide when the filter is cleared). E, change the behaviour: rank the whole result, hidden
series included, when the person asks for the eight largest, or name the button for what it does
("Colour the eight largest shown"). Add both to `chart-rules.test.mjs`.

## Majors

### M1. `check.mjs`: lint gaps, and presence rules a later rule defeats

Rubric: Tokens ("a literal it misses is still this row's failure"); AGENTS.md, "Tests must have teeth".
My v5 mutants: all 32 caught (X1 to X32; most messages name the v5 finding). Twenty new ones, each on a
copy; all were run with the token, structure and lint checks, and the eight presence-defeating ones
again with the rendered audit (results below). Survived the static checks:

| Mutant | Broken | Kind |
|---|---|---|
| Y1 | `border-color: \72 ed` (red, written with a CSS escape) | lint: identifiers are compared unescaped |
| Y3 | `border-top: thick solid var(--ink)` | lint: keyword widths |
| Y4 | `font-variant: all-small-caps` | lint: only `font-variant-caps` is read for capitals |
| Y5 | `animation: vz-spin var(--duration-slow) var(--ease) infinite` on the progress bar | nothing loops (Motion), never a spinner (owner's direction) |
| Y6 | `@property --vz-x { initial-value: red }` | at-rules whose blocks hold declarations are not walked |
| Y7 | `.vz-panel { & .vz-panel-title { margin-top: 3px } }` (nesting) | nested rules are not walked |
| Y8 | `<rect fill="red" stroke-width="3">` in a preview | HTML attributes: only hex and colour functions |
| Y9 | `Object.assign(el.style, { opacity: 0.5, color: "tomato" })`, `el.animate(…, { iterations: Infinity })`, `setAttribute("style", "opacity:.5")` | script: only `style.x =`, `cssText`, `setProperty` and `style=` strings |
| Y10 | `.vz :focus-visible { outline-color: transparent }` after the ring rule | presence: the ring rule is found, the override is not |
| Y11 | `@media (pointer: coarse) { .vz-button::after, .vz-nav a::after { content: none } }` | presence |
| Y12 | `.vz-table-wrap { position: static }` (v5 B2.1 back) | presence |
| Y13 | `.vz-swatch[data-series="6"] { border-inline-width: 0; background: var(--series) }` | presence |
| Y15 | `.vz-plot[data-emph] .vz-series-g .vz-line { stroke: var(--series); stroke-width: var(--stroke) }` (emphasis undone) | presence |
| Y16 | `.vz-chart { min-height: 0 }` | presence |
| Y17 | `.vz-table .vz-status { white-space: nowrap !important }` (v5 B2.2 back) | presence |
| Y18 | `.vz-button[data-pressed] { background: var(--ground) }` (a finger's press painted as rest) | presence |
| Y19 | `<style media="(max-width: 800px)">` | breakpoints: only `@media`/`@container` preludes are read |
| Y20 | `content: "\1F525"` (an emoji) | no rule |

Caught: Y2 (system colours, `AccentColor`), and Y14 (a transition put back under reduced motion), but
only by an unrelated rule (a press with no 0 s twin), so its subject is not guarded either.
RENDERPASS

None of these patterns is in the real CSS, previews, compositions or flow screens today (searched). The
presence rules are v6's best idea, and each is defeated by one later rule because it asks "is the fix
there?" rather than "does the fix win?". Read the cascade instead: for each guarded selector, take the
last declaration of the property in source order (with `!important` and specificity), as the swatch-ring
rule already does for its one property.

## The flow screens (as asked)

Screens 1, 7, 8 and 12 (and every other flow screen) were measured with v6's CSS, as `flows/dist` loads
it. The flow screens are still v5 markup (`flows/README.md`), so these are findings for their own review,
not this one's.

- **Page overflow: 0 px** on all twelve screens at all twelve configurations (320 to 1500 px, coarse and
  fine, 200% zoom). v5's escaping `vz-sr` head on 12 and the cause on 7 at 320 px are gone.
- **Folding tables that still scroll** (`data-fold` on tables whose columns do not fit 640 px, so they do
  not fold at 670 to 718 px of container): 1 Dashboards at 768 px coarse, 1024 px and 200% zoom (Owner,
  Last changed and Panels out of view); 8 Keys at 768 px coarse and 200% zoom (Created, Actions); 12 Who
  is notified at 768 px coarse and 200% zoom (Why, Actions and **End silence** out of view; image `11`).
  v6's rule ("a folding table never scrolls sideways": such a table is `data-fold="wide"`) and
  `tools/audit.mjs` (which loads the flow screens and reports them apart) both name this; it is the
  screens' migration, a Narrow-and-zoom blocker for them until it is done.
- **Hit areas at 400 px coarse**: screens 1, 4, 7, 8 and 12, 81 controls: none under 44 px, no overlap.
  Screen 1's "1 proposal waiting" is a link at the end of a sentence in a table cell (44 px tall, so it
  opens its line).
- The flow screens do not load `viz-press.js` yet (m3).

## Minors

- **m1 Reserved-slot ties.** Rule 3.3 picks "the reserved slot whose last holder was there longest ago";
  when several were vacated in the same result (a deploy, a query edit) the code takes the lowest slot
  number. Say so.
- **m2 A press flashes on a scroll.** `viz-press.js` marks the control pressed on `pointerdown`; a scroll
  that starts on a button paints the pressed fill (12 to 84 ms after the touch, 6 tries) before the
  browser cancels the pointer. `:active`'s delay existed for this. Defer the mark until the first frame
  without movement, or accept it and say so.
- **m3 `viz-press.js` is missing from pages that use the system**: the ten compositions load it; the
  twelve flow screens do not (they predate v6), so their presses still paint only on release.
- **m4 Theme change** on the phone layout: median 149 ms, worst 807 ms over three runs (budget 100 ms,
  not judged at load 13.9). The row to measure first on a quiet machine.
- **m5 A two-line stat context**: in the dashboard's Now row at 1500 px, "The slowest route at 15:16. ▪
  Above the 500 ms objective" is the only one of the four contexts on two lines, its mark leading the
  second; the row reads unevenly. Shorten it or let all four take two lines.
- **m6 `dist/fixture/index.html` on disk predates the last CSS change** (`dd` links): a rebuild differs in
  that rule only. Whatever is measured on the page as it is on disk is measured on the older CSS.

## Measured here

**Colour sequences** (node, the chart's own functions, 36 series): A filter, new pod, clear; B query
edited and back, twice; C deploy replacing every pod, then rollback; F server-side filter with a pod
arriving; G a range without the three largest, then back: every series returns in its own colour. D and
E: B2.

**Overflow** (page wider than the window), 53 pages x 12 configurations: 0 px everywhere. `data-fold`
tables scrolling inside their wraps: flow screens 1, 8, 12 only (see "The flow screens").

**Hit areas, 400 px coarse** (my scan, 16 pages, 480 controls): none under 44 px and no overlaps, except
the 40 pod keys of my composition (B1; each link measured at its centre, which lies outside its cell:
20.8 px tall). Covered at centre: the secret page's nav and list behind its dialog (inert, as it
should be). Links in running text: back-links and help-line links only, each on its own line.

**Keyboard**: my composition 117 stops, the Chart preview 64, the monitor composition 27, the Table
preview 14, both themes: every stop has a ring in the focus colour.

**Reduced motion** (reference): 212 transitions without, 0 with; 36 animations remain, all the
scroll-linked edge of a strip.

**A finger's press** (fixture, Run query, 400 x 800 touch, load 11.8): pressed fill 7 to 21 ms after a
finger held down (6 presses), mouse 9 to 49 ms; v5 never painted while the finger was down.

**Speed**, `speed-phone.json`, 3 runs, CPU 4x, Fast 4G, load 12.4 to 14.0 on 4 cores, calibration 679 ms:
every timing row "not judged". Medians: press 30, typing 32, touch crosshair 58, legend toggle 84 (36) and
69 (200), one panel to table 87 and 72, to chart 79, open a menu 64, **change theme 149**, run a query 34,
move to an unloaded view 62, response to paint 23 and 28, worst interaction 240 ms. Every layout-shift row
0.0000 (judged).

**Series**: `series-other` against every slot 1.30 to 1.47 (light) and 1.16 to 1.25 (dark); on the six
surfaces 4.01 to 5.83 (light) and 3.29 to 5.15 (dark). The slots are v5's: my v5 validator and contrast
tables stand.

## The author's claims, checked

(From `response.md`, read after the findings above were written.)

**Did not hold, or held only in part:**

| Claim | What I found |
|---|---|
| M4: the rubric now has one reading, the Many series row "names both blocker cases" | The row says "a series returning grey while no series **on screen** holds its slot"; the Chart README's algorithm counts a series the filter hides as holding its slot. Sequence D meets the row's words and follows the README (B2). |
| M5: "every value is walked at every depth"; colours "hex, named and system colours, any colour function in any case" | Declarations inside `@property` and nested rules are not walked (Y6, Y7); a named colour written with a CSS escape passes (Y1); a named colour or a width in an SVG attribute passes (Y8). |
| M5 / structure: "presence checks for every fix of v4, v5 and v6", "so removing a fix fails the check" | True of removing a fix; one later rule that overrides it passes for every fix I tried: the focus ring, the coarse hit areas, the positioned table wrap, a dashed swatch, emphasis, the reservation, the kept column's wrap, a finger's press (Y10 to Y13, Y15 to Y18). |
| B2: the fold pattern's changes leave "0 findings on the system's pages" | True of the pages the audit loads; none of them folds a list with long keys, kept columns and row actions, which is where the changes fail (B1). |
| Housekeeping: "the last runs … are on the tree as it is now" | `dist/fixture/index.html` on disk was built before the last CSS change (`dd` links); a rebuild differs in that rule (m6). |

**Held, checked here:** both of my v5 sequences return every colour, on the chart's functions and on
the page, through a reload (v5's images 01 and 02); flow 5's cart, 36 pods, cart (cart back
in slot 1); a server-side filter; `chart-rules.test.mjs` 10 of 10; the none-coloured note; the text
form's threshold lines over every drawn series and the note in it (M1); values below zero, the 2.5-step
precision, "> −0.1", a 3.5 threshold on data to 4.0 topping at 4 (M2); a finger's press painted from
`pointerdown` (7 to 21 ms held, v5 never), every budget row measured, load per sample, nothing judged
above the cores (M3); the rubric rows for Charts, Speed, Type and Tokens (M4); all 32 of my v5 mutants
caught (M5); the dashboard's figures and the dashboards list (M6, M7); 0 px page overflow everywhere,
the positioned wrap, the wrapping state and the actions on the key's line (B2); the audit loads the flow
screens and reports their fold tables apart, as the response says; m1, m2, m4, m5 (1.30 to 1.47 light,
1.16 to 1.25 dark), m9, m10, m11, m14 (a 2 px `rule-control` edge at the wrap's right, by pixel); "Change
theme" over its budget at the median (mine 149 ms, not judged); keyboard rings and reduced motion.

Not checked: the corpus run (`tools/mutants.mjs`, 97 mutants) and `npm test` end to end; the v5-first
runs in `evidence/`; m12 and m13; the images in `compare/` and `images/` (I rendered my own).

## Housekeeping

Everything ran on a copy in the session scratchpad; the tree was not edited except this file and
`review-images/`. One static server (port 8941, on the copy) and the harness's own server ran and are
stopped. No git command was run. No Cloudflare resource was touched.
