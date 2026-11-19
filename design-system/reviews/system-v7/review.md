# Review: viz design system, v7

Reviewed 2026-11-19 against `project/review.md` (v7's), by the reviewer who rejected v5 and v6. Inputs: the
system as it stands on disk, served and rendered here; the compositions in `compositions/`; my own v5
and v6 findings and mutants. As the coordinator directed, `response.md` was used to find what to look
at; every claim below was checked here, and none of its reasoning is taken as given. Every image cited is
in `review-images/` and was rendered here.

## Verdict: reject (by count: no blockers, three majors)

The rubric: "Reject: any blocker, or three or more majors." There are no blockers. There are three
majors, and each is small:

- **M1.** Edit an Explore query to a narrower one (add `node="node-b"`) and seven of the eight colours
  stay reserved for series that have left. Eleven of the twelve series on screen are one grey band, and
  "Colour the eight largest" is not offered. The same narrowing as a dashboard filter colours eight
  (image `03`).
- **M2.** The new pods list in the Table preview, and the new folded-list composition, set a single-unit
  numeric column ("Memory, MiB"; "Restarts" too in the composition) left-aligned at desktop width
  (`05`, `06`).
- **M3.** Twelve of my 13 new mutants survive `check.mjs` and `tools/audit.mjs`. Six undo a guarded fix
  in a context the guard does not render (coarse pointer, dark theme, a mouse rather than a finger, a
  clipping parent). Two redefine a token locally to a weaker one, which puts control borders at 1.61:1
  and the focus ring at 1.27:1 with every check green (`07`, `08`).

Everything I rejected v6 for is fixed and guarded, and I could not break it:

- **B1, the folded list** ("Actions…" on the key's line squeezed the key): no key overruns its cell at
  320 to 900 px, and names stay whole (`01`, `02`).
- **B2, the colour rule** (the Chart README and the rubric disagreed): they now say the same thing, and
  the code follows it. Seventeen of 17 chart tests pass, and my own property check found no violation
  in 37,500 steps.
- **Overflow:** no page scrolls sideways in 672 loads.
- **v6 M1, the check:** of my 20 v6 mutants, 19 are caught. The last (Y15) was my error: it never broke
  emphasis, as the response says.

The decided cost is acceptable under the rubric: a filter round trip with more than eight series
brings the hidden series back in Other, with the note (point 3 below). Fix the three majors and this can
be approved in a short round.

## How this was checked

- **Build:** a copy of `design-system/` in the session scratchpad. `npm run build` there reproduces every
  generated file byte for byte, the fixture page included. The v6 m6 fix holds.
- **Colour rules:** driven in node through the chart's own `chartModel`, `assignSeries` and `recolour`, as
  the author's tests load them:
  - my nine sequences: A to I from v6, plus a narrowing done both ways;
  - a property check of my own, written from the rubric's blocker list without reading the author's
    tests: 3 seeds, 1,500 random sequences, 37,500 steps;
  - `chart-rules.test.mjs`: 17 of 17.
  
  On the running preview page: the stated cost, the narrowed query, `setData` and reloads.
- **Folded lists:** my v5/v6 firing-monitor composition (40 pods, cut key links, two kept columns, row
  actions), the new `folded-list` composition, and v6's Monitors fold with real names. Key overrun
  measured at 320, 360, 400, 480, 600 and 900 px with a coarse pointer.
- **Overflow sweep:** 56 pages × 12 configurations = 672 loads:
  - pages: 11 compositions, 12 flow screens, 31 previews (Cover included), the reference and mine;
  - coarse pointer: 320, 360, 400, 480, 600 and 768 px;
  - fine pointer: 1024, 1200, 1440 and 1500 px;
  - 200% zoom: 720 and 750 CSS px.
- **Compositions:** twelve pages (the eleven and mine), both themes, 1500 px fine and 400 px coarse. Hit
  areas measured at 400 px coarse (493 controls).
- **Keyboard and motion:** keyboard walks in both themes on four pages. Reduced motion on the reference.
  A finger's press, a mouse press and a scroll starting on a button, on the fixture.
- **Mutants:**
  - my 52 earlier mutants (X1–X32, Y1–Y20) against `check.mjs`;
  - the eight that survive it, through `tools/audit.mjs` (`--quick`, on a built copy, with the pages
    each guard needs);
  - 13 new ones (W), each through both tools, and each survivor confirmed to break what it claims by
    injecting it into the running page;
  - all on copies, never in the tree.
- **Machine:** 4 cores shared with other sessions; 1-minute load 6.6 to 11.1 throughout. **No timing
  can be judged** (see Timings).

Not checked:
- a screen reader by ear, Safari and Firefox, real touch hardware, enlarged text as distinct from zoom;
- the author's full corpus run (130 mutants), the full 14-configuration audit, and the theme trace;
- the flow screens beyond overflow (they are v5 markup, not this review's subject).

## Images

| File | Shows |
|---|---|
| `01-v6-b1-folded-pods-key-on-its-line-320-400-560-coarse.png` | My 40-pod folded list at 320, 400 and 560 px: the key has its own line, the kept figures open the second under their heads, "Actions…" ends it |
| `02-v6-b1-monitors-fold-names-whole-400-coarse.png` | v6's image 02 case (long monitor names, row actions): names whole on one line |
| `03-narrowed-query-one-coloured-eleven-grey-no-recolour-light-1200.png` | The 36-pod chart after its query is narrowed to node-b: one line, eleven pods in a grey band, "1 coloured by size; 11 in Other", no "Colour the eight largest" (M1) |
| `04-stated-cost-filter-round-trip-three-largest-in-other-light-1200.png` | "Without the three largest" and back: the three largest inside Other, "3 in Other are now larger than a coloured series", the recolour offered |
| `05-table-preview-memory-column-left-aligned-light-1500.png` | The Table preview's new pods list: "Memory, MiB" left-aligned beside right-aligned CPU and Throttled (M2) |
| `06-folded-list-memory-restarts-left-aligned-light-1500.png` | The folded-list composition: "Memory, MiB" and "Restarts" left-aligned (M2) |
| `07-mutant-w2-focus-ring-clipped-before-after.png` | W2: a row of controls that clips its overflow (fine pointer only): the ring loses its top and bottom; every check passes (M3) |
| `08-mutant-w23-w24-border-and-ring-weakened-before-after.png` | W23 and W24: `rule-control` and `focus` redefined to `rule` in a row of controls: border 1.61:1, ring 1.27:1; every check passes (M3) |
| `09-folded-list-dark-400-coarse.png` | The folded-list composition, dark, 400 px coarse |
| `10-states-long-table-dialog-monitor-traces-400-coarse.png` | Empty and error states, long table, dialog, monitor and traces at 400 px coarse, mixed themes |

## My v6 findings, checked

| v6 | Now | Evidence | Guarded so it cannot regress? |
|---|---|---|---|
| **B1** folded list: key squeezed, long names drawn over the figures | **Fixed** | 0 of 40 keys overrun their cell at 320, 360, 400, 480, 600 and 900 px; v6: 40 of 40 at 320–480 px. Below 640 px, two kept columns open the second line under the key, which keeps its own line (`01`); with one kept column the key keeps its line beside it (dialog list at 320 px). Long monitor names stay whole (`02`). Hit areas at 400 px coarse: none under 44 px, no overlap, in all twelve compositions. | **Yes.** My control mutant (the folded key's minimum removed) is caught by the audit's `cut` check at 320 and 400 px coarse and 720 px at 200%. The response's Z mutants claim the same for key-width and overlap; not re-run here. |
| **B2** Chart README and rubric gave two verdicts | **Fixed** | See "B2: the lead's rule" below. | **Yes.** `chart-rules.test.mjs`, 17 tests, each blocker example one test, 400 random sequences; my independent property check agrees. |
| **M1** `check.mjs`: lint gaps; presence rules a later rule defeats | **Fixed** for every v6 mutant that was valid | Y1–Y9, Y14, Y19 and Y20 are caught by `check.mjs` without render. Y16 is caught by its rendered reserved-height check (re-run here: "reserves 0 px and draws 490.5 px"). Y10–Y13, Y17 and Y18 are caught by `tools/audit.mjs`: focus guard, hit-area guard, escape, swatch guard, kept-state guard, press guard. **Y15** is not caught and does not need to be: my selector `.vz-plot[data-emph] .vz-series-g .vz-line` (0,4,0) is weaker than the emphasis rule (0,5,0) and broke nothing. I withdraw it; the response was right. | Mostly. New gaps: **M3**. |
| m1 to m6 | Fixed or decided | m1: the tie rule is in the text. m2: accepted and written in States; a scroll that starts on a button paints the fill for 6 to 15 ms before the browser cancels it. m3: reported for the flows. m4: Timings below. m5: the context is one line now. m6: the fixture rebuilt; `stale` check. | m6: yes (`stale`). |

## B2: the lead's rule, point by point

**1. The documents now say the same thing.**
- Chart README rule 3 ("what a person sees wins": on screen, hidden, away; held, reclaimable, reserved,
  free; the five steps).
- The rubric's Many series row: the same guarantees, and the same five blocker examples.
- The code comment on `assignSeries`: the same algorithm.

**2. The code follows them.**
- `chart-rules.test.mjs`: 17 of 17 pass here.
- My own property check, written from the rubric's list and not from the author's tests: 1,500 random
  sequences of 25 steps (add, remove, a pod that leaves as another arrives, a filter on a random third,
  clear, query edited away and back, a person's recolour, values moving), checking after every step:
  - a colour on screen never changes while its series stays on screen;
  - no series on screen is grey while a slot is free or owned only by a hidden series;
  - a series coming back is never grey, nor in another colour, while no series on screen holds the slot
    it last had.
  
  **No failure in 37,500 steps.** One apparent failure on the first run was my own check's error: it
  forgot that a series last seen in Other comes back in Other.
- My v6 sequences on v7, each consistent with the rule:
  - A, filter / new pod / clear: ends with the three largest and the new pod in Other, "4 in Other are
    now larger than a coloured series".
  - B, query edited to search and back, twice: every colour returns.
  - C, every pod replaced by a deploy, then rolled back: every colour returns.
  - D: the returning pod is in Other because 403cb, on screen, took its slot when the filter hid new01.
  - E: the three largest return in Other after the person's recolour; the note says so.
  - F, a server-side filter: consistent.
  - G, a range without the three largest: every colour returns.
  - I, eight services filtered and cleared: every colour returns.

**3. The cost** (above eight series on screen, a filter applied and cleared brings the hidden series back
grey, with a note) **is acceptable under the rubric.**
- The Many series row says it in terms: "A series a filter hid that comes back in Other, because a
  series on screen took its slot while it was hidden, follows the rule (the note must then say it is
  larger than a coloured series)".
- On the page the note says "3 in Other are now larger than a coloured series" and "Colour the eight
  largest" is beside it (`04`).
- It is still a real cost, and the one the app review rejected in v4 (AR-M2: "the three largest … are
  grey hairlines"). It is now a recorded decision with a test that would reverse it ("how long filters
  stay applied in recorded sessions"). Before the application ships, that measurement should be taken,
  and the author's alternative (hand the slot back on clear while the borrower ranks in the bottom half)
  kept ready.

## Majors

### M1. A narrowed query leaves the series on screen grey beside reserved colours, with no way to colour them

Rubric: Many series (a failure the row does not name as a blocker, so major); Feedback, "Useful … offer
the next step". Rule: Chart, rule 3 ("what a person sees wins": "the colours belong first to what is
on screen") against rules 4 and 6. Image `03`.

Rule 4 never lends a reserved slot "to a series already on screen in Other". Rule 6 offers "Colour the
eight largest" only when a member of Other is larger than a coloured series, or none is coloured.
Measured in node, and on the preview page with `setData` (36 pods, then the query narrowed to the twelve
on node-b):

| The same narrowing | Coloured | In Other |
|---|---|---|
| Explore, matcher edited to `node="node-b"` (the other pods leave: away) | 1 (…3742c, slot 1) | 11, with 7 slots reserved for pods not in the result |
| Dashboard filter `node="node-b"` (the other pods are hidden) | 8 | 4 |

In the first case the note reads "1 coloured by size; 11 in Other". The action row offers only "Show 11
more of Other". The chart stays that way until the query is edited back. The largest series in Other
(1.6 cores) is not larger than the one coloured series (3.0), so nothing invites a recolour. Narrowing a
query is the commonest move in Explore. The README rejected alternative (a), the largest series on screen
grey "beside a colour nobody can see", for filters; this is that picture for query edits.

Fix, smallest first:
- offer "Colour the eight largest" whenever a series on screen is in Other while any slot is not held
  on screen, and say why in the note ("7 colours wait for series not in this result");
- or let rule 4 lend reserved slots to on-screen series that the round trip can do without: those
  whose owner has been away for more than one result.

Add the narrowing to `chart-rules.test.mjs`.

### M2. Single-unit number columns left-aligned in the new pods list and folded-list composition

Rubric: Type, "Numbers that are compared … in `mono`, right-aligned in a column of one unit" (major).
Rule: Table, "A column of one unit is `vz-right`". Images `05`, `06`.

- **Table preview:** the pods list that v7 added has `<th class="vz-label">Memory, MiB</th>` and
  `<td class="vz-num" data-label="Memory, MiB">`, with no `vz-right`.
- **`compositions/folded-list.html`:** the same, and also for "Restarts".

Above `breakpoint-wide` these lists do not fold. At 1500 px "Memory, MiB" (and "Restarts") reads
left-aligned beside right-aligned CPU and Throttled. Adding `vz-right` changes nothing in the folded form
(tried at 400 px coarse: the folded line reads the same). So this is an omission, and the preview teaches
it. The audit does not check alignment: a cell whose `data-label`, or whose head, names a unit could be
required to be `vz-right`.

### M3. Twelve of 13 new mutants survive both `check.mjs` and `tools/audit.mjs`

Rubric: Tokens, Contrast, Keyboard and Touch are blocker rows; these are the checks that keep their fixes
in place. AGENTS.md, "Tests must have teeth". Rule: project README, "Design changes" step 7: merging
needs an approve verdict and passing checks. Images `07`, `08`.

Each mutant was applied to a copy, built, and run through `check.mjs` (with its rendered audit) and
`tools/audit.mjs --quick` on the pages its guard reads. Each survivor was then injected into the running
page, in the context it targets, to confirm it breaks what it says:

| Mutant | Broken | Confirmed on the page | Why both tools pass |
|---|---|---|---|
| W1 | `@media (pointer: coarse) { .vz :focus-visible { outline-color: transparent } }` | Tab with a coarse pointer (a tablet with a keyboard): outline `rgba(0,0,0,0)` | the focus guard runs at 1500 px with a fine pointer only |
| W2 | `@media (pointer: fine) { .vz-controls { overflow: hidden } }` | the ring of a focused button in a row of controls loses its top and bottom (`07`) | the guard reads the computed outline, not what is painted |
| W3 | `@media (pointer: coarse) { .vz-swatch[data-series="6"] { border-inline-width: 0; background: var(--series) } }` | swatch 6 solid at 400 px coarse | the swatch guard runs at 1500 px fine only |
| W4 | `[data-theme="dark"] .vz-plot[data-emph] .vz-series-g:not([data-emph-on]) .vz-line { stroke: var(--series); stroke-width: var(--stroke) }` | emphasis in dark: the lines that should step back keep their colour at 2 px | the emphasis guard runs in light only |
| W5 | `@media (pointer: fine) { .vz-button:active, .vz-button[data-pressed] { background: var(--ground) } }` | a mouse press on a default button: rest, hover `#ededed`, held `#ffffff` (no press) | the press guard presses by touch at 400 px coarse only; `check.mjs` measures text under a press, not the fill |
| W6 | `@media (prefers-reduced-motion: reduce) and (pointer: coarse) { .vz-menu { transition: opacity var(--duration-slow) var(--ease) !important } }` | with reduced motion and a coarse pointer, the menu transitions over 0.18 s | the reduced-motion pass runs at 1500 px fine only |
| W8 | `.vz-panel-title { --vz-w: 650; font-weight: var(--vz-w) }` | a weight off the scale | lint: a whole number in a custom property passes, `var()` passes; the token trace does not cover weights |
| W9 | `.vz-menu { --vz-e: steps(4); transition-timing-function: var(--vz-e) }` | a second easing | lint reads easings only in transition and animation properties; the trace does not cover easing |
| W10 | `.vz-panel-title { font-variation-settings: "wght" 650 }` | a weight off the scale | no rule reads it |
| W17 | the third picked member of Other drawn solid (`.vz-swatch[data-pattern="dot"]`, its line's dash removed) | the first and third picked members look alike | no page picks members of Other, so no guard sees them |
| **W23** | `.vz-controls { --rule-control: var(--rule) }` | a secondary button's border at **1.61:1** (needs 3:1) | tokens only, so the lint and the trace pass; the rendered contrast audit measures text, swatches and lines, not borders |
| **W24** | `.vz-controls { --focus: var(--rule) }` | the focus ring at **1.27:1** (needs 3:1) | the focus guard compares the ring with the element's own `--focus`, which the mutant redefined |

Caught: W7 (the waiting line moved down over the plot: the hit-area guard at 320 and 400 px coarse), and
my control mutant (the folded key's minimum removed: `cut`).

None of these patterns is in the system today. The CSS redefines one token locally (`--mark` in the page
state), and no colour token. These are regressions the gate would let through; they are not present
defects.

Fix:
- run each rendered guard in every configuration the audit already loads (both pointers, both themes);
- read what is painted where it matters: a ring clipped by an ancestor, a press's fill under a mouse;
- forbid redefining a colour token outside the theme blocks, and give the trace the original token
  values to compare against;
- read weights and easings through custom properties and `font-variation-settings`;
- put picked members of Other on a page the audit loads.

## Minors

- **m1 Stacked folded rows cost density.** With two kept columns below 640 px, each pod row is about
  120 px tall at 400 px coarse (key line, figures line with "Actions…", folded line): 40 pods take about
  4,800 px. The response states the trade-off (no third breakpoint). Layout says "density is a feature";
  if it matters, a third table breakpoint is the change it names.
- **m2 `tools/audit.mjs`'s header** still says it loads "reviews/system-v6/compositions/"; the code takes
  the latest review's.
- **m3 A segmented control is drawn taller with a coarse pointer** (44 px). It is a stated exception,
  with its reason, and it renders cleanly; the list of exceptions in "Every form factor" grows by one.

## Point 4: new regressions in the composed screens

Two regressions, M1 and M2 above; otherwise none:
- the full dashboard, the dialog (open and closed), empty and error states, the long table, the folded
  list, traces and the monitor, both themes, 1500 px and 400 px coarse (`09`, `10`);
- 0 px page overflow in 672 loads;
- no control under 44 px and no overlap at 400 px coarse (493 controls);
- every keyboard stop ringed in both themes (my composition 117 stops, folded list 96, Chart preview 64,
  Table preview 22);
- reduced motion: 222 transitions, none with reduce; the remaining animations are only the strips'
  scroll-linked edges;
- a finger's press painted 6 to 39 ms after the touch (4 presses, load 8.9; v5: never).

The flow screens are unchanged since v6 and still v5 markup. Their `data-fold` tables that do not fit
640 px still scroll at 768 px coarse, 1024 px and 200% zoom (screens 1, 8 and 12), and they do not load
`viz-press.js`. Both are for their own migration, as the audit reports.

## Timings

**I agree that no timing row can be judged.** The rubric's rule is: a row is judged only when most of
its samples were taken at a load of 4 or less on these 4 cores.
- `speed/phone.json` and `desktop.json`, both sides: samples taken at a load of 6.6 to 9.5; no timing
  row is marked judged.
- My own short run: `speed-phone.json`, 2 runs, at a load of 6.8 to 7.7, with a calibration of 307 ms; every timing row is "not judged" there too.

The calibration ratio (309 to 325 ms against about 100 ms idle) is context only, as the rubric now says.
What can be judged:
- **layout shift:** every row 0.0000 on the phone, within budget (the author's, and mine);
- **mechanisms, which do not depend on load:** a finger's press paints, and the theme change's cost is
  style recalculation of every element (the author's trace; not re-traced here).

"Change theme" has been above 100 ms at the median at both layouts in every session that measured it:
v6 102 to 154 ms, v7 110 and 135 ms, and 145 ms in my run (158 ms at p75). It is still the row to measure first on a quiet machine. Until it is
judged, the Speed row (a blocker row) is open, neither passed nor failed, as in every review since v4.

## Measured here

- **Colour:** sequences A–I and the property check above; `chart-rules.test.mjs` 17 of 17.
- **Folded list:** key overrun 0 at six widths on three lists (mine, the composition's two, v6's
  Monitors). Hit areas 493 controls, none under 44 px.
- **Overflow:** 672 loads, 0 px. `data-fold` tables scrolling inside their wraps: flow screens only.
- **Mutants:**
  - `check.mjs` without render: 44 of my earlier 52 caught;
  - `check.mjs` with render: Y16 (caught);
  - `tools/audit.mjs`: Y10–Y13, Y17 and Y18 caught;
  - Y15 withdrawn;
  - new: 12 of 13 survive (M3).
- **Speed:** `speed-phone.json`, 2 runs, CPU 4x, Fast 4G, load 6.8 to 7.7 on 4 cores, not judged. Medians:

  | Row | Median |
  |---|---|
  | Press (finger) | 31 ms |
  | Typing | 22 ms |
  | Touch crosshair | 50 ms |
  | Legend toggle, 36 / 200 series | 69 / 63 ms |
  | One panel to table, 36 / 200 series | 79 / 69 ms |
  | One panel to chart | 77 ms |
  | Open a menu | 65 ms |
  | Change theme | **145 ms** |
  | Run a query | 51 ms |
  | Move to an unloaded view | 60 ms |
  | Response to paint, 36 / 200 series | 21 / 26 ms |
  | Worst interaction | 144 ms |

  Layout shift: 0.0000 in all six rows, judged and within budget.

## The author's claims, checked

**Did not hold, or held only in part:**

| Claim | What I found |
|---|---|
| M1: "every guarded fix is checked by what it does when rendered … so a later rule that overrides it fails whatever its spelling" | A later rule fails only in the context the guard renders. Overrides limited to a coarse pointer, the dark theme or a fine pointer pass (W1, W3, W4, W5, W6). A ring clipped by its parent passes (W2). A token redefined locally passes every guard (W23, W24). |
| B2: "the largest series on screen is never grey while" a slot can be given | True of free and reclaimable slots, as the rule defines them. With reserved slots (a narrowed query), eleven series on screen stay grey beside seven unused colours, with no recolour offered (M1). The rule says this; the principle's name promises more. |
| Table preview and folded-list composition as worked examples of the fold | They set a single-unit number column left-aligned (M2). |

**Held, checked here:**
- B1's fix, at every width I tried, on three lists.
- The README and rubric in the same words, and the code following them (tests and my property check).
- The stated cost and its note (`04`).
- Y1–Y14 and Y16–Y20 caught, and Y15 rightly set aside.
- `npm run build` reproducing `dist/` and the fixture.
- 0 page overflow, and the flow screens' remaining fold scroll as reported.
- m1, m2, m5 and m6.
- Every timing row "not judged" at the loads recorded.
- The finger's press.

**Not checked:** the 130-mutant corpus run, the full audit, the theme trace, `evidence/`.

## Housekeeping

Everything ran on a copy in the session scratchpad. The tree was not edited, except this file and
`review-images/` (10 images, 0.9 MB). One static server (port 8951, on the copy) and the speed harness's
server ran; both are stopped. No git command was run. No Cloudflare resource was touched.
