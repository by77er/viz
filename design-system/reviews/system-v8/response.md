# Design system v8: response to the v7 review

The input is `reviews/system-v7/review.md` (reject: no blockers; majors M1 to M3; minors m1 to m3; the timings), its ten images, and
the coordinator's direction, which gives the project lead's rule for M1: a series that is not in the result is not on screen either,
so its slot is open exactly as a hidden series' is. Status: **not reviewed.** It needs an independent review under `project/review.md`.

"Before" is v7 exactly as it was on disk at the start of this session: a copy of `design-system/` (md5 of `src/components.css`
`31666653…`) taken before any edit and built by its own tools, in the session's scratch area. Every failing-first run below was run
against that copy. Nothing outside `design-system/` was edited; `flows/`, `reviews/system-v4/` to `reviews/system-v7/` and `app/` were
not touched. Nothing was published. No git command was run.

## How it was checked

All on this machine: 4 cores shared with other sessions, 16 GB. Each run below gives its own load. One browser at a time, at most one
test worker, every server stopped.

- **Failing first, on v7.** The new chart tests (`evidence/chart-rules-on-v7.txt`) and the audit's new checks
  (`evidence/audit-new-checks-on-v7.txt`) were run against the v7 copy. The reviewer's 13 mutants were run on v7 by the reviewer
  (1 caught); here they ran against v8.
- **`npm test`**: `chart-rules.test.mjs` and `check.test.mjs` (the corpus without its browser mutants).
- **`tools/mutants.mjs`**: the whole corpus, @@CORPUS@@, browser mutants included, each on a copy in the scratch area.
- **`tools/check.mjs`** on the component CSS (with its rendered audit), the previews, the compositions and the fixtures.
- **`tools/audit.mjs`**: every page at its 14 configurations, the guards in both themes at both pointers, presses by finger and mouse,
  hover, the token trace and the reduced-motion pass in both themes at both pointers.
- **Images**: `tools/shots.mjs`, before (the v7 copy, with v7's compositions) and after, same data and state, composed side by side
  in `compare/`; composed screens in `images/`.
- **Speed**: `tools/speed.mjs --compare`, both shipped scenarios, v7's fixture and v8's alternating run by run, the load beside every
  row.

## Every v7 finding, at a glance

| v7 finding | Change | Guarded by |
|---|---|---|
| M1 a narrowed query leaves the screen grey beside reserved colours, nothing offered | One rule for every way the screen changes: a series not in the result is not on screen, so its slot is open as a hidden series' is; the largest series on screen in Other take open slots at once; "Colour the eight largest" offered wherever Other has members | `chart-rules.test.mjs`: the reviewer's narrowing (failing first on v7), 300 random narrowing sequences done twice (query edit, dashboard filter) that must colour alike, 400 random sequences with narrow-and-back among the moves; mutants C1, C2, C4, C14, C15; `compare/v8-m1-query-narrowed-to-node-b-*`, `images/v8-chart-query-node-b-*` |
| M2 single-unit number columns left-aligned | `vz-right` on "Memory, MiB" (Table preview) and on "Memory, MiB" and "Restarts" (folded-list composition) | the audit's **align** check, rendered, on every page at every configuration (failing first on v7); mutants U2, U3; `compare/v8-m2-*` |
| M3 each guard renders one context; a token redefined locally passes | Every guard in both themes and both pointers; rings and borders read as painted, against the theme's tokens; a system token is defined once, by its theme (lint), and checked on every element as rendered; custom properties, `font-variation-settings` and picked members of Other read | the reviewer's 13 (W1 to W10, W17, W23, W24) all caught; v8's own U1 to U9; the reviewer's 65 caught; @@CORPUS@@ |
| m1 stacked folded rows cost density | The row is its key link's target; the key's line and "Actions…" are drawn at their own height; the 44 px are the row's | rows measured below; U5, U6 and the hit-area guard; `compare/v8-m2-m1-folded-list-400-*` |
| m2 the audit's header names v6 | Rewritten: the latest review's compositions, every guard and context | `tools/audit.mjs` lines 1 to 44 |
| m3 a segmented control drawn taller with a coarse pointer | Drawn at its own height; a wrapped one keeps its rows apart by a gap, so the 44 px hit areas do not meet | U8 and the hit-area guard at 320 px; `compare/v8-m3-segmented-preview-*`, `images/v8-chart-controls-320-coarse-light.png` |
| Timings | The load beside every timing; every row above the stated load "not judged" | `speed/` |

## Majors

### M1. A narrowed query left the screen grey beside reserved colours, with nothing offered

**What changed.** The rule is now one rule for every way the screen changes (Chart README, rules 3 to 7; the rubric's Many series row;
`project/README.md`, Colour; `method.md`'s worked example; `assignSeries` and `legendActions` in the Chart preview, the one source of
`dist/viz-chart.js`). A series is *on screen* (in the result and not hidden by the view's filter), *hidden* (the view's filter hides it)
or *away* (not in the result). To the colours, hidden and away are the same: neither is on screen. A slot is *held* while its owner is
on screen and *open* otherwise. On each step: series that stay keep their colours; a series coming on screen takes its own slot back
if no series on screen holds it; then every grey series on screen, largest first, takes an open slot (free slots first, then the one
whose owner left the screen longest ago, ties to the lowest). So a series on screen is grey only while all eight slots are held on
screen. "Colour the eight largest" is offered wherever Other has members (`legendActions(model)`; v7 offered it only when a member of
Other was larger than a coloured series). A query narrowed to node-b and the same dashboard filter now colour the eight largest pods on
node-b alike; legend rows chosen or unchosen change what is drawn and never a colour.

**The cost, stated in the README ("Why this rule")**: with more than eight series on screen, a series that leaves and comes back (a
filter applied and cleared, a query narrowed and widened, a pod that misses one result) finds its slot held on screen and comes back
in Other, where the note says so if it is larger than a coloured series, and the recolour is offered. With eight or fewer on screen nothing changes
colour. A query edited to series it does not share and edited back still returns every colour (v5 review, image 02), because the other
query's series leave the screen and free the slots.

**What guards it.**
- `tools/test/chart-rules.test.mjs`, 20 tests. New: the reviewer's narrowing (image 03), done by query edit and by dashboard filter,
  which must give the same colours, the eight largest on node-b coloured, the recolour offered, and the round trip alike both ways;
  **twins**: 300 random sequences of 30 steps (narrow to a node or a random subset, widen, arrive, leave, values move, legend toggles,
  recolour) run once as query edits and once as a dashboard filter, colours equal after every step, every property held, a legend
  toggle never changing a colour; the 400 random sequences now include narrowing and widening; P3 now reads "a series on screen is
  grey only while all eight slots are held on screen, and then the recolour is offered".
- **Failing first on v7** (`evidence/chart-rules-on-v7.txt`): 10 of 20 fail on v7; with the offer check left out
  (`VIZ_NO_OFFER=1`) 4 still fail on colour alone, the reviewer's narrowing among them ("11 on screen in Other while only 1 slots are
  held on screen").
- Mutants: C1 (a series that leaves the screen forgets its slot), C2 (v7's asymmetry), C4 (v7's rule 4: a slot whose owner left the
  result is not given to a grey series), C14, and C15 (the recolour offered only when a member of Other is larger): all caught.
- The preview: the 36-pod panel has a query segment "node-b only" beside "Search only", so the narrowing can be done on the page;
  a new panel, "CPU by pod, three of Other picked out", picks three members of Other (for M3's W17).
- Images: `compare/v8-m1-query-narrowed-to-node-b-{1440,400}-{light,dark}.png` (v7 left: one coloured, eleven grey, no recolour; v8
  right: eight coloured, four in Other, the recolour offered), `images/v8-chart-query-node-b-*` (by the page's own segment).

Not taken: the reviewer's first fix alone (the offer and a note, slots still reserved), because it leaves the picture the rule exists
to prevent on screen until the person acts; and the second (lend a slot after its owner has been away more than one result), because
it is two rules for one picture. Both are in the README's "Weighed and not taken".

### M2. Single-unit number columns left-aligned

**What changed.** `vz-right` on the head and cells of "Memory, MiB" in the Table preview's pods list, and of "Memory, MiB" and
"Restarts" in `compositions/folded-list.html`. The Table README says the rule is guarded.

**What guards it.** A new **align** check in `tools/audit.mjs`, rendered, on every page at every one of the 14 configurations: in
every table (not folded at that width), a column whose cells all hold a bare number of one unit (the unit in its head) must have
every figure and the head end at the cell's right edge, measured from the text's own box. It reads what is drawn, so a later rule, a
missing class or a different alignment at one pointer all fail.
- Failing first on v7 (`evidence/audit-new-checks-on-v7.txt`): the Table preview's "Memory, MiB" (4 cells, "675" 210 px short) and
  the folded list's "Memory, MiB" and "Restarts" (41 cells each).
- Mutants U2 (a single-unit column left-aligned) and U3 (right-aligned columns made left-aligned by a later rule at the fine pointer):
  caught.
- Images: `compare/v8-m2-table-preview-*`, `compare/v8-m2-m1-folded-list-*`.

### M3. Each guard rendered one context; a token redefined locally passed every check

**What changed in the checks.**
- **Every context.** Each guard runs in both themes at 1500 px with a fine pointer and at 400 px with a coarse one; hit areas at
  320, 400 and 768 px coarse; the reduced-motion pass in both themes at both pointers; a press by a real mouse (moved over, then held)
  at 1500 px as well as by a finger (CDP touch events) at 400 px; hover guards (a ring with a mouse over it, dashed swatches and
  emphasis hovered).
- **What is painted.** The focus ring is read as drawn: its width, offset and colour against the theme's `focus` (the theme root's
  value, not the element's own), 3:1 on what is behind it, and no ancestor that clips it (`overflow` other than visible between the
  control and its scroller cuts it unless the ring is drawn inside). Control borders (buttons, inputs, selects, segmented controls,
  checkboxes) at 3:1 on what is behind them, as painted. Each control's hit area by hit testing, and now also nine points of each
  box it draws: a neighbour's hit area reaching into them fails.
- **Tokens.** The lint forbids redefining a system token outside its theme block (in CSS, a style attribute or a composition;
  `project/README.md`: "A token is defined once, by its theme"). The audit's token trace checks every token on every element against
  its theme's value (a redefinition from script, which no lint reads, fails there), and moves every token (colours inverted, lengths
  and durations doubled, weights one step heavier, curves bent) to find values that do not follow.
- **Lint bypasses.** A custom property is resolved where it is read, so a weight or easing set through one is linted as that property
  (W8, W9); `font-variation-settings` is read as a weight (W10) and fails in the trace on any element.
- **Picked members of Other** are on a page the audit loads (the new Chart panel), and the guard requires each picked member's line
  and swatch to have its own pattern (W17).

**Defects the new guards found in v8's own pages, fixed:** the navigation's focus ring cut by its strip with a coarse pointer (now
inside, like the tabs); the legend's sort buttons and action buttons, and a sort button filling its head, with rings cut (inside); the
log's "Show all … lines" ring cut by the table wrap (inside); `<b>`/`<strong>` at the browser's 700 (now the strong weight token);
`--mark` redefined on the page state (now `--mark-size`, a component variable); and "Actions…" in a stacked folded row whose hit area
reached the key's last words (the key's line now ends that far above it).

**What guards it.** The reviewer's 13 (W1 to W10, W17, W23, W24, written as the review gives them) are in the corpus and all caught;
so are v8's own nine (U1 to U9): U1 redefines `rule-control` and `focus` from script at run time, where no lint can see it, and is
caught by the rendered focus and contrast guards. @@MUTANTS@@

## Minors

| | Finding | Change | Shown by |
|---|---|---|---|
| m1 | Stacked folded rows cost density (about 120 px a pod at 400 px coarse) | The whole folded row is its key link's target (the key's link covers the row; other controls lie above it), so the key's line no longer needs 44 px of its own, nor does the line "Actions…" ends; with a coarse pointer the row is at least 44 px and starts `space-2` above the key. In the stacked form the key's line ends `(control-touch − control-sm) / 2` above "Actions…", so its hit area does not reach the key's words. No third breakpoint | Pods list, median row: **120 → 98 px at 400 px coarse** (40 pods: 4,800 → 3,920 px), 142 → 120 px at 320 px; monitors 134 → 119 px at 400 px (measured here on both copies); B1's checks (overlap, key-width) still clean at every configuration; U5, U6 and the hit-area guard; `compare/v8-m2-m1-folded-list-400-*` |
| m2 | The audit's header named v6 | Rewritten: it names the latest review's compositions, every check, the guards and their contexts | `tools/audit.mjs`, lines 1 to 44 |
| m3 | A segmented control drawn 44 px tall with a coarse pointer | Drawn at its own height; when it wraps (320 px) its rows are kept apart by `control-touch − control-md + 2 hairline`, so the 44 px hit areas of stacked segments do not meet. `project/README.md` ("Every form factor") says so: no longer a drawn size | U8 (rows without the gap) caught by the hit-area guard at 320 px; `compare/v8-m3-segmented-preview-*`; `images/v8-chart-controls-320-coarse-light.png` (hit areas drawn) |

@@SPEED@@

## The page audit, final run

`tools/audit.mjs`, every page: 31 previews, the reference, the fixture, the 11 compositions, and the 12 flow screens reported apart
(56 pages), at 14 configurations (320 to 1500 px fine; 320, 400 and 768 px coarse; 200% zoom of 1280, 1440 and 1500 px windows).
**System pages: 0 findings.** Flow screens (read only, reported apart): 122 findings, all known and for the flows' own revision: the
press guard finds a finger's press never painted on 11 screens (they do not load `viz-press.js`), four folding tables on screens 1, 8
and 12 that scroll at 800 px and up, 768 px coarse or 200% zoom (`data-fold="wide"` is their fix), and screen 1's "1 proposal
waiting", a link inside a sentence drawn as a control. As printed: `evidence/audit-full.txt`.

`tools/check.mjs` on the component CSS (tokens, structure, the rendered contrast and reservation audit): @@CHECK@@. On the previews,
the compositions and the fixtures (`--no-render`): 775 of 775 checks, 0 literal values in 45 files.

`npm test`: 173 tests, **131 pass, 0 fail**, 42 skipped: the 20 chart tests, and the corpus's 111 mutants that need no browser
(96 for `check.mjs`, 15 for the chart rules); the 42 that need a browser (34 audit, 8 rendered check) are skipped there unless
`VIZ_SLOW=1`, and ran in the corpus run above. 97 s.

## Images

Both themes, 1440 and 400 px (the 400 px images with a coarse pointer and touch), same data and state; v7 left, v8 right, each
composed by `tools/shots.mjs compare` and palette-encoded, none over 500 KB.

@@IMAGES@@

## The flow screens

Unchanged and read only, as before; what the audit reports on them is above. They load the system's `dist/viz.css`, so they get v8's
fold (the row as the key's target) and rings without a change of markup; their press script and `data-fold="wide"` remain theirs.

## Migration (for the flows and the app, to be re-imaged on v8)

**No class was renamed or removed.** What changes under existing markup:

- Tokens: `version` 8. No token was added or removed. A token may no longer be redefined below its theme: a component that needs
  another value uses a variable of its own. The page state's larger status mark is now `--mark-size` (set on `.vz`, `var(--mark)` by
  default; `.vz-page-state` sets it to `space-3`). Code that set `--mark` on an element must set `--mark-size`.
- Folding tables: with a coarse pointer the whole row is its key link's target (the key's link covers the row; links, buttons, inputs,
  selects and summaries in other cells lie above it), the row is at least `control-touch` tall and padded `space-2` at its top; the key
  cell no longer has a 44 px minimum. In the stacked form (two kept columns below 640 px) the key cell's bottom padding is
  `(control-touch − control-sm) / 2` and "Actions…" is drawn at its own height.
- Focus rings drawn inside the control (offset minus `stroke`) in the navigation, the legend's sort and action buttons, a sort button
  with a coarse pointer, and the log message's button.
- `<b>` and `<strong>` inside `.vz` take `text-ui-strong-weight`.
- A segmented control with a coarse pointer: segments at their own height, rows apart by a gap when it wraps.
- Charts: `newMap()` is `{ v: 8, n, owner, s }`; maps are kept under `vz-series8:` (v7's are not read: v7 kept a reserved slot for
  a series away, which v8 does not). `vzChartRules.legendActions(model)` returns what the row under Other offers (`'more'`,
  `'recolour'`). The chart object has `otherKeys()`; a chart element may carry `data-pick="N"` to pick out N members of Other on load
  (the preview uses it).
- `tools/audit.mjs` adds the kinds `align` and `contrast`, and `hit-area` also samples what each control draws; `tools/lib/lint.mjs`
  reports `token` (a system token redefined) and reads custom properties and `font-variation-settings`; `tools/check.mjs` passes it the
  token names.

## Disagreements, and what was not done

- **No timing row could be judged** in most rows (above); the theme change remains the row to measure first on a quiet machine.
- `design/DECISIONS.md` is outside `design-system/`, where this work was confined; the M1 decision is recorded in the Chart README
  ("Why this rule": decision, alternatives weighed, the cost, what would change it). An entry there is for the owner of `design/`.
- The flow screens and the app are not re-imaged on v8 (`flows/` and `app/` were not to be edited).
- The audit's alignment check reads tables that are not folded at that width; a folded line ("Memory, MiB 661") is text, not a column.
- Mutant C1 was rewritten: v5's order (the filter applied before colours are assigned) became equivalent under v8, where a hidden
  series and one not in the result are the same to the colours; C1 now makes a series that leaves the screen forget its slot. U9 runs on
  the Section preview: a claim's strong words have their own weight rule, so removing the general one changes nothing there.

## Files

- `src/components.css` (v8: rings inside where clipped, the fold's row target and stacked spacing, strong words, `--mark-size`,
  segmented rows), `project/tokens.json` (version 8), `project/README.md` (colour, focus ring, a token defined once, numbers
  right-aligned, the segmented exception removed), `project/review.md` (the Many series row), `project/method.md`.
- Components: Chart (`preview.html`: the v8 algorithm, `legendActions`, the "node-b only" segment, the picked panel; `README.md`:
  rules 3 to 7 and "Why this rule"), Table (`preview.html`: `vz-right` on Memory; `README.md`: the row as the key's target, alignment
  guarded).
- Tools: `audit.mjs` (header; align; guards in every context; contrast; hit areas with drawn-box sampling; the token trace with scope,
  weights and curves; presses by mouse and finger; hover; reduced motion at both pointers), `lib/lint.mjs` (`token`, custom properties,
  `font-variation-settings`), `lib/structure.mjs` (the fold's touch entry), `check.mjs`, `mutants-corpus.mjs` (W1 to W10, W17, W23, W24;
  U1 to U9; C1 to C15 for v8), `test/chart-rules.test.mjs` (rewritten for v8: the narrowing, twins, P3).
- `reviews/system-v8/`: this file; `compositions/` (v7's, with `vz-right` on Memory and Restarts in `folded-list.html`);
  `shots-compare.json`, `shots.json`; `compare/`; `images/`; `speed/`; `evidence/` (the runs as printed).
- `README.md` (version 8, the tools, the corpus, history, the flows' status).

## Housekeeping

@@HOUSEKEEPING@@
