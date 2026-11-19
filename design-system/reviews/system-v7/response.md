# Design system v7: response to the v6 review

The input is `reviews/system-v6/review.md` (reject: B1, B2, M1, minors m1 to m6, the flow screens' notes, 20 new mutants of
which 17 survived), its eleven images, `reviews/system-v6/response.md` for what v6 did, and the coordinator's direction, which carries
the project lead's decision on B2 ("what a person sees wins"). Status: **not reviewed.** It needs an independent review under
`project/review.md`.

"Before" is v6 exactly as it was on disk at the start of this session: a copy of `design-system/` (md5 of `src/components.css`
`f9594320…`) taken before any edit and built by its own tools, in the session's scratch area. Every failing-first run below was run
against that copy. Nothing outside `design-system/` was edited; `flows/`, `reviews/system-v4/`, `reviews/system-v5/`,
`reviews/system-v6/` and `app/` were not touched. Nothing was published. No git command was run.

## How it was checked

All on this machine: 4 cores shared with other sessions, 16 GB. The 1-minute load average was 5.9 to 11 through the session (each
run below gives its own). One browser at a time, at most one test worker, every server stopped.

- **Failing first, on v6.** The new chart tests, the page audit's new checks and the reviewer's mutants were each run against the
  v6 copy before any v7 result was taken.
- **`npm test`**: `chart-rules.test.mjs` (17 tests) and `check.test.mjs` (the corpus without its browser mutants).
- **`tools/mutants.mjs`**: the whole corpus, 130 mutants, browser mutants included, each on a copy in the scratch area (one base
  directory, each copy deleted after its run; the runner refuses a directory inside the tree).
- **`tools/check.mjs`** on the component CSS (with the rendered contrast and reservation audit), the previews, the compositions
  and the fixtures.
- **`tools/audit.mjs`**: every page (31 previews, the reference, the fixture, the 11 compositions, and the 12 flow screens reported
  apart) at 14 configurations, with the new overlap and key-width checks at every one, the guards, the token trace and a
  reduced-motion pass.
- **Images**: `tools/shots.mjs` before (the v6 copy) and after, same markup and state, composed side by side in `compare/`;
  compositions at 1500 px and 400 px with a coarse pointer, both themes, 320 px, 200% zoom, hit areas and greyscale, in `images/`.
- **Speed**: `tools/speed.mjs --compare`, both shipped scenarios, v6's fixture and v7's alternating run by run, and a Chromium
  trace of the theme change.

## Every v6 finding, at a glance

| v6 finding | Change | Shown by |
|---|---|---|
| B1 folded list: key squeezed, names drawn over the figures | The key keeps half the row (`key-min`), its cut engages, two kept columns go under a key that has its own line below 640 px, "Actions…" leaves the key's line | `tools/audit.mjs` overlap and key-width at all 14 configurations (failing first on v6); mutants Z1 to Z4, Z8; `compare/v7-folded-list-*`, `compare/v7-table-preview-*`, `compare/v7-dialog-list-closed-*`; `images/v7-folded-list-*` |
| B2 colour: README and rubric disagree | The lead's decision, "what a person sees wins", written once in the Chart README and the same in the rubric; `assignSeries` rewritten to it | `chart-rules.test.mjs`: D, D at 36 pods, E, each rubric blocker example, 400 random sequences (10 of 17 fail on v6 first); mutants C10 to C14; `compare/v7-b2-*` |
| M1 checks: lint gaps, overridable presence rules | Lint gaps closed; each guarded fix checked as rendered in `tools/audit.mjs`; a token trace of every colour, length, duration and opacity | the reviewer's 20 as Y1 to Y20; CORPUS |
| m1 reserved-slot ties | "ties: the lowest slot" in the rule | Chart README rule 3.3 |
| m2 a press on a scroll | accepted and said in States | `project/README.md` |
| m3 press script in the flows | reported by the press guard, apart; the flows' to fix | the audit's flow section |
| m4 theme change 149 ms | measured again and traced: style recalculation of every element; not judged at load 7 to 9 | Speed, below |
| m5 two-line stat context | shortened | `compare/v7-dashboard-*` |
| m6 stale fixture page | rebuilt; the audit's `stale` check | mutant Z7 |

## Blockers

### B1. A folded list squeezed its key; long keys were drawn over the figures

**Root cause.** v6 put "Actions…" on the key's line and gave each kept column at least its longest phrase; the key took what was
left, with no minimum, and nothing let its cut engage: the key link was a flex item that could not shrink below its content, and a
`vz-cut` in a cell was capped at half the measure, not at its cell (`max-width: calc(var(--measure) / 2)` overrode the cut's own
`max-width: 100%`). So a 215 px pod name sat in an 87 px cell and was drawn across the CPU figures. And nothing checked it: the
audit treated text in a `vz-cut` as cut on purpose, and no composition folded a list with long keys, two kept columns and row actions.

**Change** (Table README, "Fold"; `src/components.css`, the fold blocks; `project/README.md`, "Every form factor"):

- **The key keeps at least half the row** (`key-min`, a new size token, 50%). Each kept column is `keep` wide (25%, was 26%, so two
  of them leave the key exactly half) and never narrower than its longest phrase; their width does not depend on their words, so they
  line up down the list.
- **The cut engages**: the key's link shrinks with its cell (`min-width: 0` on what the key holds) and a `vz-cut` in a cell is capped
  at `min(100%, half the measure)`. A long identifier is cut in the middle, keeping its distinguishing end; a long name wraps inside
  the key. Nothing in the key is drawn outside it.
- **Two kept columns below `breakpoint-narrow`**: a row cannot hold a readable key beside two columns there (at 320 px a row is
  288 px), so the key takes the whole first line and the kept columns open the second, under their heads; the head row folds the same
  way. With one kept column the key keeps its line beside it at every width (at 320 px, 216 px of 288).
- **"Actions…" never shares the key's line**: it ends the next line at the row's right edge (after the folded cells, or after the
  kept columns when the key has its line to itself). With a coarse pointer that line is `control-touch` tall, so the button's whole
  hit area lies inside the row.

Not taken: a third breakpoint for tables (it would have let two kept columns stay beside the key down to some width between 320 and
640 px, but the system's rule is two widths, both tokens, and the stacked row reads well at 600 px too); a CSS grid with subgrid rows
(it aligns content-sized columns, but cannot flow the folded cells as a line); per-row wrapping (it would put a row's figures on the
key's line in one row and under it in the next).

**Guard** (`tools/audit.mjs`, at every one of the 14 configurations, every page):

- **overlap**: every visible word, clipped to the boxes that clip it, is hit-tested at its centre with the page scrolled so it is in
  view; the element found there must be the word's own (or hold it, or be held by it). Anything else means one is drawn over the
  other: a name over the figures, a cell over the name. A control's invisible hit area over another control's words is reported too;
  overlays that lie over the page by design (open menus, dialogs, floating notices, tooltips, a waiting line over its strip) are not.
  Independent of hit testing, two words of different elements whose boxes overlap by more than a third of the smaller are reported.
- **key-width**: a key in a folded table narrower than `key-min` of its row.
- The existing **cut** check now also sees the end of a cut name lying outside its cell.
- The case is a composition: `compositions/folded-list.html` (40 pods with cut key links, CPU and Throttled kept, Memory, Restarts
  and Node folded, row actions; four monitors with names as long as real ones, Now and Threshold kept, row actions). The Table
  preview's Monitors list now has row actions and those names, and a pods list beside it.

Failing first: the new audit on v6 (the v6 copy, the same composition and the Table preview, quick set): **overlap** at 320 and 400 px
coarse ("2.87" in a CPU cell lies under "c6b5-73b1d"; "912" under "checkout-api p99 latency, POST /…"), **key-width** at 320 and
400 px coarse and at 720 px at 200% ("checkout-api p99 latency, POST /…" 45 px of a 286 px row; "cart-7d9f8c6b5-73b1d" 49 px of 286;
the Table preview's "checkout p99 latency" 122 px of 270), and **cut** ("c6b5-73b1d" outside its cell, over its neighbour). On v7:
none, at all 14 configurations (below).

**Teeth**: Z1 (the key's minimum removed: structure), Z2 (v6's arrangement of a one-kept list, actions on the key's line and no key
minimum: key-width, 116 px of a 286 px row at 320 px), Z3 (the cut uncapped and the link unable to shrink: cut and overlap), Z4 (the
key's own line removed: structure), Z8 (v6's fold whole: overlap and key-width), and A2, A3 (v5's B2.2) still caught.

**Images**: `compare/v7-folded-list-*` (v6 left: names over the figures at 400 px, five-line names; v7 right),
`compare/v7-dialog-list-closed-*` (one kept column: the key keeps its line, "Actions…" ends the folded line),
`compare/v7-table-preview-*`; `images/v7-folded-list-*` (1500, 400 coarse, 320 coarse, 200% zoom, hit areas).

### B2. The Chart README and the rubric gave two verdicts on the same chart

**Decision** (the project lead's, recorded in the Chart README, "Series colour" rule 3 and "Why this rule", and in the rubric's Many
series row, in the same words): **what a person sees wins.** A series on screen keeps its colour while it stays on screen; a slot held
only by a series the view's filter hides is reclaimable, so the largest series on screen is never grey while such a slot exists;
"Colour the eight largest" applies to what is on screen; clearing a filter is a step like any other. This replaces v6's rule 3, under
which a hidden series kept its slot for as long as it was hidden.

**The algorithm, written once** (Chart README rule 3; the same text is the comment on `assignSeries` in the Chart preview, the one
source of `dist/viz-chart.js`). On screen, hidden, away; each slot has an owner; a slot is held (owner on screen), reclaimable (owner
hidden), reserved (owner away) or free. Each step: (1) series on screen at both steps keep their colour; (2) series coming on screen
take their slot back unless a series on screen owns it (a hidden or away owner gives it up; the more recent holder wins a tie);
(3) new series, and those whose slot a series on screen owns, by rank: lowest free, else the reserved slot whose owner has been away
longest (ties: lowest slot, the v6 review's m1), else the lowest reclaimable, else Other; (4) while a slot is free or reclaimable and a
series on screen is in Other, the largest such series takes the lowest such slot; (5) record. Hidden series are never given a slot.
The map is now stored under `vz-series7:` (v6's maps are not read).

**What the reviewer's two sequences now do**, as tests that failed on v6 first:

| Sequence | v7 | v6 (failing first) |
|---|---|---|
| **D**, eight services: catalog (slot 1) misses one result while catalog-canary arrives (takes slot 1, reserved); the canary is filtered out; catalog comes back | catalog takes slot 1 back: its holder is hidden. Clearing the filter brings the canary back in Other, with the note | catalog grey, in Other, while nothing on screen held slot 1 |
| **D** as the reviewer ran it, 36 pods: the largest misses one result while new01 arrives (slot 1); new01 is filtered out; the largest comes back | the moment new01 is hidden, the largest pod in Other (the ninth largest) takes slot 1; the returning pod finds it held on screen and joins Other: "1 in Other is now larger than a coloured series" | after the filter, 28 pods grey while slot 1 was held only by the hidden new01 |
| **E**: "Without the three largest"; a pod larger than all arrives; "Colour the eight largest"; clear | the filter gives slots 1 to 3 at once to the 9th, 10th and 11th largest; the new pod joins Other with the note; "Colour the eight largest" colours the eight largest on screen (the new pod in slot 1); clearing brings the three back in Other: "3 in Other are now larger than a coloured series", beside "Colour the eight largest" | after the filter, 28 pods grey while slots 1 to 3 were held only by hidden pods |

Both sequences end with series in Other, now by the rule rather than against it: in D a series on screen holds the returning pod's
slot; in E every slot is held on screen. The rubric no longer names "a series hidden by a filter returning grey" as a blocker; it names
the cases the decided rule forbids.

**Guard** (`tools/test/chart-rules.test.mjs`, on the chart's own functions, without a page; 17 tests):

- The two sequences above (three tests: D with eight services, D with 36 pods, E).
- **Each blocker example of the rubric's Many series row**, one test each: a readout naming a smaller series as highest; a series on
  screen changing colour while it stays on screen (a deploy replacing the three largest, a filter on a new pod, cleared); the largest
  series on screen grey while a slot is held only by a hidden series; a series coming back grey or in another colour while no series on
  screen holds its slot (a pod that misses one result); a query edited and edited back not returning every colour.
- The earlier reviews' sequences under the v7 rule: v5's image 01 (now ends with the three largest and the new pod in Other, "4 in
  Other are now larger than a coloured series"), a dashboard filter round trip with nothing grey on screen (every colour returns), flow
  screen 5.
- **400 random sequences of 30 steps** (arrivals, departures, values moving, a filter in the chart or in the query, cleared, a query
  edited and back, Other opened and members picked, "Colour the eight largest" with or without a filter in force), with the
  properties checked after every step: P1 a colour on screen is kept while the series stays on screen, and a series on screen leaves
  Other only for a slot no series that stays on screen had; P2 a query edited and back returns every colour, and a hidden series that
  still holds its slot when the filter is cleared comes back in it; P3 no series on screen is grey while a slot is free or held only by
  hidden series, a series coming on screen takes its slot back whenever no other series on screen holds it, hidden series never gain a
  slot, placement and reclaiming go largest first; P4 to P6 as in v6 (highest, threshold and text form over every drawn series; the
  note's counts); P7 "Colour the eight largest" colours the eight largest on screen and nothing else. The properties judge slots by
  owner among series on screen or hidden, so they read v6's map and v7's alike.

Failing first, on v6: 10 of 17 fail (the three sequences, four of the five blocker tests, v5's image 01 under the new rule, and the
random sequences, each on P3 at the first filter with grey series on screen; the query round trip fails only on the note's new words,
"8 coloured by size; 28 in Other", which no longer says "when first seen" because a reclaimed slot is given by size later). On v7:
17 of 17.

**Teeth**: C10 (v6's rule: no reclaiming) fails D and E; C11 (reclaimed slots to the smallest first), C12 (hidden series placed as if
on screen), C13 (the reviewer's other fix for E, not taken: "Colour the eight largest" ranking hidden series too), C14 (a returning
series taking its slot from a series on screen) each fail a property; C1 to C4 and C7 rewritten for the v7 code, C5, C6, C8 and C9 unchanged, all caught.

**Images**: `compare/v7-b2-filter-three-largest-*` (the 36-pod panel with "Without the three largest": v6 leaves the three largest
pods in Other grey beside three unused colours; v7 colours them), `compare/v7-b2-e-filter-pod-recolour-clear-*` and
`compare/v7-b2-v5-sequence-filter-new-pod-clear-*` (the ends of E and of v5's sequence: on both sides the returning pods are in Other,
on v7 by the rule, with the note), `compare/v7-b2-eight-services-filter-and-clear-*` (eight series: every colour returns on both).

## Majors

### M1. `check.mjs`: lint gaps, and presence rules a later rule defeats

**Root cause.** Two different weaknesses. The lint read spellings its author expected (unescaped names, the declarations of plain
rules, `style` written three ways), so each new spelling was a new gap. And the presence rules asked "is the fix there?", so one later
rule that overrides it passed. Closing spellings one by one keeps losing; so v7 does both: the parser-based lint closes the listed
gaps, and **every guarded fix is checked by what it does when rendered**, in `tools/audit.mjs`, so a later rule that overrides it fails
whatever its spelling; and a **token trace** checks, as rendered, that every colour, length, duration and opacity on every page comes
from a token.

**Lint** (`tools/lib/lint.mjs`): identifiers, functions, units and property names are read unescaped (Y1); `thin`, `medium` and
`thick` are lengths in a width (Y3); small capitals in `font-variant` and `font-feature-settings` are capitals (Y4); `infinite` or a
count above one in an animation is a loop, and a keyframe that rotates is a spinner (Y5); declarations inside every at-rule
(`@property`, `@font-face`, `@page`) and inside nested rules are walked, nested selectors resolved against their parent (Y6, Y7); SVG
presentation attributes are values, in markup and in markup written by script (Y8); script that writes style by
`Object.assign(el.style, …)`, `el.animate(…)` (its properties, a written-out duration or easing, and `iterations` above one),
`setAttribute('style' | a presentation attribute, …)` or `style['…'] =` is read as CSS (Y9); a `media` attribute on `<style>`,
`<link>` or `<source>`, and `matchMedia()`, are conditions checked against the breakpoint tokens (Y19); an emoji anywhere is reported
(Y20). Selector lists are split at depth zero (`:is(a, b)` is one selector; the old split broke it).

**Rendered guards** (`tools/audit.mjs`, at 1500 px with a fine pointer and at every coarse width; a finger's press and the token trace
at 400 px coarse; a reduced-motion pass at 1500 px):

| Fix | Guarded by, as rendered | Mutant |
|---|---|---|
| Focus ring | every focusable control focused from the keyboard: outline solid, `stroke` wide, in `focus`, offset `stroke` (a hairline in a segmented control, inside a tab strip); a legend row and a waterfall span: the row's cells draw the ring in `focus` | Y10 |
| Coarse hit areas | every control's area measured by what the page finds 21 px above, below, left and right of its centre (44 px, less a pixel at each end where two areas meet and hit testing snaps), at 320, 400 and 768 px coarse; a link inside running text is exempt | Y11 |
| Positioned table wrap | computed `position` of every `.vz-table-wrap` (and the existing escape check) | Y12 |
| Dashed swatch | slots 5 to 8: both side borders solid, wider than zero, in the slot's colour, on no fill | Y13 |
| Reduced motion | with reduced motion requested, no element transitions and none animates by the clock | Y14 |
| Emphasis | a legend row focused: every line that steps back is a `series-other` hairline | Y15 |
| Reservation | (already) the check's rendered reserved-against-drawn height | Y16 |
| A kept state wraps | computed `white-space` of every state in a kept column of a folded table (and the cut check) | Y17 |
| A finger's press | a CDP touch held on each kind of control (plain, quiet and toned buttons, a chosen and an unchosen segment, menu rows, sort heads, tree toggles, legend rows): the fill painted is the press token, not the rest | Y18 |
| Nothing loops | no element's computed animation repeats forever unless it follows a scroll | Y5 |

**Token trace** (every page, at 1500 px light and 400 px coarse dark): every element inside `.vz` is read, then every token is moved
(colours inverted, `px`, `ch` and `ms` doubled) by one added stylesheet with transitions held still, and the element read again, in
one task. A colour, length (margins, paddings, gaps, border and outline widths, radii, font size, line height, spacing, underline,
min and max sizes, SVG stroke widths), duration, or a `box-shadow` part that does not move was written out somewhere: a stylesheet, a
style attribute, a script, an SVG attribute, an escape, or the browser's own default. An opacity other than 1 has no token at all.

**What the guards found in the system on their first run** (each fixed in the system, each a mutant now):

- A chosen segment showed no press: `[aria-pressed="true"]` came after `[data-pressed]` at the same weight (Z5).
- At 320 px a segmented control that wraps stacked its segments, so their hit areas overlapped: segments are now `control-touch`
  tall with a coarse pointer, a stated exception in "Every form factor".
- At 400 px, in the reference, the legend's action row wrapped "Show 20 more of Other" and "Colour the eight largest" and the first
  button's hit area reached the Other row (Z6): the row is padded with a coarse pointer, still `legend-row` tall on one line, so the
  chart's reservation is unchanged.
- A small button in a row of controls above a plot reached 2 px into the plot: such a row keeps `space-1` above and below.
- Checkboxes and tree toggles kept the browser's font size and colour (13.33 px, `fieldtext`): both inherit now.
- The reference page's own frame wrote 32 px, 12 px and a 900 px breakpoint: now tokens and `breakpoint-wide`.

**The corpus**: the reviewer's 20 mutants are Y1 to Y20 in `tools/mutants-corpus.mjs`, each written from the review's table (Y15 is
written at the weight of the rule it overrides: a weaker selector does not override emphasis, so it would break nothing; Y14 puts a
transition back on the progress bar, which has no press rule, so only the reduced-motion guard can catch it). v7's own: Z1 to Z8.

CORPUSRESULT

## Minors

| | Finding | Change | Shown by |
|---|---|---|---|
| m1 | Reserved-slot ties broken by slot number in the code, not in the text | The text says it: "ties: the lowest slot" (Chart README, rule 3.3) | the rule; the code comment is the same text |
| m2 | A press flashes on a scroll that starts on a button | **Accepted, and said** (`project/README.md`, "States"): the press shows until the browser takes the gesture as a scroll, as native controls do; holding the mark back until the finger is still would put every press a frame late, which the first budget row forbids | the rule |
| m3 | `viz-press.js` missing from the flow screens | Not mine to change (`flows/` is not edited here). The audit's press guard now reports it on every flow screen, apart from the system's pages | `tools/audit.mjs`, flow screens section |
| m4 | Theme change: median 149 ms against 100 ms | Measured again and traced (Speed, below) | `speed/`, the trace table |
| m5 | A two-line stat context in the dashboard's Now row | "The slowest route at 15:16." is now "The 6 min to 15:16.", the same words as the errors stat beside it; the label already names the route | `compare/v7-dashboard-*` |
| m6 | `dist/fixture/index.html` older than the last CSS change | Rebuilt; and `tools/audit.mjs` now starts with a **stale** check, by content: `dist/viz.css` is what the build makes of the tree, `dist/viz-chart.js` and `dist/viz-press.js` are their sources, and the fixture and reference inline the current CSS and chart. Mutant Z7 (the CSS changed after the build) is caught | Z7; every audit run |

## The flow screens

Read only, reported apart by the audit, as in v6: the folding tables of screens 1, 8 and 12 that do not fit 640 px still scroll at
200% zoom and up to 1024 px (they need `data-fold="wide"`), screen 1's "1 proposal waiting" is a link at the end of a sentence in a
cell, and now also: no flow screen loads `viz-press.js` (m3), so the press guard finds a finger's press never painted there (52
controls on 11 screens). The flow screens load the system's `dist/viz.css`, so they now have v7's fold: the new overlap and key-width
checks find nothing on them at any of the 14 configurations. For the flows' own revision.

AUDITRESULT

## Speed, and the theme change (v6 review, m4)

`tools/speed.mjs --compare`, both shipped scenarios, v6's fixture (the v6 copy, built by its own tools) and v7's alternating run by
run, **3 runs each, not 20**: every sample of the last four sessions was taken above the core count, and a loaded run is not judged
however many runs it has, so I scaled down and say so. Measured on this machine, on the system's fixture page (a floor, not the
application), CPU 4x and Fast 4G. Results: `speed/phone.json`, `speed/desktop.json`; the printed tables are `evidence/speed-*.txt`.

**Load, with every row.** 4 cores. Phone: the 1-minute load at the start of each run was 6.9 to 8.5; desktop: 6.8 to 8.8. The load is
recorded with every sample; the table gives its median for each row and side. The rule: a timing row is judged only when most of its
samples were taken at a load of 4 or less. **Every timing row on both layouts is "not judged"** (load 7.0 to 8.5 at the samples);
**every layout-shift row is judged, and within budget** at both layouts, both versions. Calibration task 309 to 325 ms against about
100 ms idle (context only). p75 (median), ms:

| Phone, 400 x 800, coarse pointer, touch | v6 | load | v7 | load | Budget | |
|---|---|---|---|---|---|---|
| Press: Run query (a held finger, by the fill painted) | 52 (30) | 7.5 | 35 (34) | 8.0 | 50 | not judged |
| Typing in the query editor | 137 (35) | 7.8 | 22 (16) | 8.0 | 50 | not judged |
| Crosshair by touch drag, 36 series | 53 (47) | 7.8 | 51 (46) | 8.0 | 50 | not judged |
| Legend row toggle, 36 / 200 series | 87 (82) / 66 (63) | 7.8 | 79 (78) / 68 (67) | 8.0 to 8.1 | 100 | not judged |
| One panel to table, 36 / 200; to chart, 36 | 113 (88) / 156 (79); 93 (89) | 7.8 | 129 (90) / 82 (80); 100 (84) | 8.1 | 100 | not judged |
| Open a menu (Share…) | 67 (56) | 7.8 | 156 (82) | 8.1 | 100 | not judged |
| **Change theme (to dark)** | **200 (154)** | 8.1 | **142 (135)** | 8.1 | 100 | not judged |
| Run a query: sent, waiting state shown | 63 (62) | 8.1 | 66 (51) | 8.1 | 100 | not judged |
| Move to a view whose data is not loaded | 69 (60) | 8.1 | 59 (57) | 8.5 | 100 | not judged |
| Response to paint, 36 / 200 series | 39 (33) / 41 (30) | 8.0 to 8.1 | 25 (21) / 32 (27) | 8.5 | 100 | not judged |
| Worst interaction (Event Timing) | 304 (184) | 8.0 | 256 (152) | 8.5 | 200 | not judged |
| Layout shift: load and run; loaded scrolled to each of five charts | 0.0000 everywhere | 7.8 to 8.0 | 0.0000 everywhere | 8.0 to 8.5 | 0.05 | **judged: within** |

| Desktop, 1440 x 900, fine pointer | v6 | load | v7 | load | Budget | |
|---|---|---|---|---|---|---|
| Press: Run query | 22 (20) | 7.5 | 26 (21) | 7.2 | 50 | not judged |
| Typing in the query editor | 29 (22) | 7.5 | 37 (35) | 7.2 | 50 | not judged |
| Crosshair, 3 / 36 / 200 series | 25 / 43 / 31 | 7.5 | 39 / 80 / 57 | 7.2 | 50 | not judged |
| Legend row toggle, 36 / 200 series | 82 (54) / 75 (60) | 7.5 | 73 (65) / 70 (51) | 7.2 to 7.5 | 100 | not judged |
| One panel to table, 36 / 200; to chart, 36 | 90 (64) / 88 (56); 74 (44) | 7.5 | 77 (64) / 81 (67); 55 (49) | 7.5 | 100 | not judged |
| Open a menu (Share…) | 92 (49) | 7.5 | 63 (62) | 7.5 | 100 | not judged |
| **Change theme (to dark)** | **123 (102)** | 7.5 | **163 (110)** | 7.5 | 100 | not judged |
| Run a query: sent, waiting state shown | 48 (40) | 7.3 | 44 (39) | 7.5 | 100 | not judged |
| Move to a view whose data is not loaded | 69 (44) | 7.3 | 75 (41) | 7.5 | 100 | not judged |
| Response to paint, 36 / 200 series | 100 (71) / 32 (29) | 7.3 | 71 (70) / 39 (36) | 7.8 | 100 | not judged |
| Worst interaction (Event Timing) | 144 (120) | 7.0 | 184 (136) | 7.8 | 200 | not judged |
| Layout shift: load and run; loaded scrolled to a chart | 0.0004; 0.0002 | 7.3 to 7.8 | 0.0004; 0.0002 | 7.0 to 7.8 | 0.05 | **judged: within** |

Three runs at a load of 7 to 8.5 do not say whether v7 is faster or slower than v6 anywhere: the same row moves by tens of
milliseconds between runs of the same version (v6's typing p75 137 ms against a median of 35 ms). Nothing in v7 touches a measured path
except the fold rules (no fold table on the fixture), the colour map (assignment is O(series) per step) and a few coarse-pointer rules.

**The theme change.** It cannot be judged here: every sample was taken at a load of 7.1 to 9.3 on 4 cores. What it spends its time on
can be measured at any load, so I traced it (a Chromium trace of one tap on "Dark", phone layout, CPU 4x, v6 and v7 alternating, 3
each; `evidence/theme-trace.txt`):

| Tap to the end of the frame | Style recalculation | Elements restyled | Layout | Pre-paint | Paint | Load |
|---|---|---|---|---|---|---|
| v6: 196, 196, 178 ms | 82, 64, 75 ms | 1,682 to 1,726 | 4 ms | 7 to 17 ms | 18 to 25 ms | 7.7 to 8.2 |
| v7: 142, 80, 133 ms | 78, 39, 60 ms | 1,648 to 1,738 | 1 to 6 ms | 5 to 8 ms | 11 to 40 ms | 7.7 to 8.3 |

The cost is style recalculation of every element on the page (the fixture has 1,381 elements; a theme change moves every colour token
on the root, so every element's style is recomputed), then paint; layout is a few milliseconds, and no script runs (the chart does not
redraw on a theme change). So there is no slow path to remove short of restyling less: the candidates, if a quiet run shows the row
over budget, are `content-visibility: auto` on panels below the fold (it skips their style and paint, but their reserved heights would
then have to be given as intrinsic sizes, or the layout-shift rows, which are judged and pass, would move) and fewer rules whose
rightmost part is universal or an attribute (every element is matched against those). I did not make either change on numbers that
cannot be judged. **The row to measure first on a quiet machine.**

## Migration (for the flows and the app, to be re-imaged on v7)

**No class was renamed or removed.** What changes under existing markup:

- Tokens: `keep` 26% → 25%; new `key-min` (50%). `version` 7.
- Folding tables (both forms): the key keeps at least `key-min`; what the key holds may shrink (`min-width: 0`), and a `vz-cut` in any
  cell is capped at `min(100%, half the measure)`, so a cut engages in a narrow cell; "Actions…" (`td.vz-row-actions`) leaves the key's
  line and ends the next line; below `breakpoint-narrow`, a table with two `data-priority="1"` columns gives the key its own line and
  the kept columns open the second (the head row too). Markup is unchanged; a flow screen that worked around v6's fold (actions as a
  kept column, a state folded under the key) can drop the work-around.
- With a coarse pointer: segments of a segmented control are `control-touch` tall; the legend's action row is padded so wrapped small
  buttons keep their 44 px inside it; a row of controls directly in a panel has `space-1` above and below.
- A chosen segment shows its press (the press rule now follows the chosen one).
- Checkboxes in `vz-check` and tree toggles inherit font and colour (they kept the browser's 13.33 px and `fieldtext`).
- Charts: `vzChartRules.assignSeries(map, series, { visible, filteredOut })` takes `visible` (the view's own filter, a predicate over
  a series) beside `filteredOut` (keys a filter in the query excludes); `newMap()` is `{ v: 7, n, owner, s }`; `slotOf` returns the slot
  a series owns now (0 when a series on screen took it). Maps are kept under `vz-series7:` (v6's are not read). The legend note's third
  sentence is "N coloured by size; M in Other"; "No series is coloured" says only "not in this result".
- `tools/css.mjs` exports `tokenCss(tokens)`; `tools/audit.mjs` has the kinds `overlap`, `key-width`, `stale`, `guard`, `focus`,
  `hit-area`, `press`, `motion` and `token`; `tools/mutants.mjs` takes `after` (an edit made after the build).

## Disagreements, and what was not done

- **The colour decision has a cost, and I say it rather than hide it.** With more than eight series on screen, a filter applied and
  cleared now brings the series it hid back in Other (v5's image 01 sequence, which v6 fixed, ends that way again, now by the rule).
  The lead decided it; the Chart README records the alternatives and what would change it (how long filters stay applied in recorded
  sessions). If the decision is revisited, the smallest change that keeps "what a person sees wins" and restores most round trips is to
  hand a hidden series' slot back when the filter is cleared if the series that took it is still in the bottom half of the coloured
  ones by rank; I did not build it, because it adds a third kind of repaint and the decision did not ask for it.
- **Stacked rows between 480 and 639 px.** A pods list there could keep its two figure columns beside the key (the key would have
  about 220 px); it stacks, at one line more per row, because the system has two widths and no third for tables. A third breakpoint
  token would be the change if that line matters more than one rule.
- **A segmented control is drawn taller with a coarse pointer** (44 px instead of 32): a stated exception to "drawn sizes do not change",
  with its reason. The alternative, a gap between wrapped rows inside one bordered control, reads as two controls.
- **What the token trace does not cover**: easing, weights, font families, z-index, angles in transforms, percentages, and widths and
  heights (those are layout, not declared values, and a page's width is not a token). The lint covers each of those by spelling;
  `check.mjs`'s rendered audit covers contrast as painted. The trace reads elements inside `.vz` only.
- **Presence checks stay**, beside the rendered guards: they run in a second without a browser and name the review a fix came from.
  The rendered guards are what decides; a presence check that is satisfied while the guard fails is the guard's finding.
- **Y15** is written at the weight of the emphasis rule it overrides: the review's spelling (a weaker selector) does not override
  emphasis, so it breaks nothing and "surviving" says nothing. Y14 puts a transition back on an element that has no press rule, so the
  unrelated press rule that caught the review's version cannot catch it; only the reduced-motion guard can.
- **C7** (the note counted over the whole result) became an equivalent mutant under v7 (rule 4 gives a hidden series' slot to the
  screen whenever anything is in Other, so the two counts agree whenever the note can say them); it now counts Other over the result,
  which the properties catch.
- **The two "SMALL" lines in `evidence/compositions-measure.txt`** (folded list at 320 px and the hit-area image at 400 px) are
  controls cut by the bottom of a fixed-height image, measured where the viewport ends; the audit's hit-area guard, which scrolls each
  control into the middle of the view, finds nothing on that page at 320, 400 or 768 px.
- **Not done**: the flow screens (not mine to edit: their fold tables at 200% zoom, the press script, a link in a sentence); `app/`
  (on v4); a screen reader by ear; Safari and Firefox; real touch hardware (every touch here is Chromium's emulation); enlarged text as
  distinct from zoom. No timing row is judged, for the fifth session running.

## Files

- `src/components.css` (v7: the fold, the touch exceptions, the segmented press order, inherited fonts), `project/tokens.json`
  (version 7, `keep`, `key-min`), `project/README.md` (colour, states, form factors), `project/review.md` (the Many series row),
  `project/method.md`.
- Components: Chart (`preview.html`: the algorithm, the note, the demo panels' words; `README.md`: rules 3 to 7 and "Why this rule"),
  Table (`README.md`: the fold; `preview.html`: monitors with real names and row actions, a pods list).
- Tools: `lib/lint.mjs` (the gaps), `lib/structure.mjs` (the v7 fold's presence checks; selector lists split by depth), `audit.mjs`
  (stale, overlap, key-width, the guards, the token trace, reduced motion), `css.mjs` (`tokenCss`), `mutants-corpus.mjs` (Y1 to Y20,
  Z1 to Z8, C10 to C14, C1 to C4 and C7 rewritten, A-mutants on v7's compositions), `mutants.mjs` (`after`), `reference.mjs` (its frame
  in tokens), `test/chart-rules.test.mjs` (rewritten for the decided rule).
- `reviews/system-v7/`: this file; `compositions/` (v6's ten, the dashboard's stat context shortened, and `folded-list.html`);
  `shots-compare.json` and `shots.json`; `compare/` (40 pairs, v6 left, v7 right) and `images/` (35), each palette-encoded to its 256
  most frequent colours, none over 500 KB; `speed/`; `evidence/` (the final runs as printed).
- `README.md` (version 7, the tools, history, the flows' status).

## Housekeeping

No mutant was applied in the tree: every one ran on a copy under the session's scratch area, each deleted after its run (the runner
refuses a directory inside the tree). The v6 copy used for "before", the raw captures and the JSON outputs were deleted at the end. No
edit is half-finished: the final runs of `check.mjs`, `npm test`, the corpus and the audit are on the tree as it is now. Servers
started by the audit, the harness, `shots.mjs` and the trace script stopped with them. No git command was run. No Cloudflare resource
was touched; nothing was published.
