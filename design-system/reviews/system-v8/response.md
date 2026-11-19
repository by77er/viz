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
| M3 each guard renders one context; a token redefined locally passes | Every guard in both themes and both pointers; rings and borders read as painted, against the theme's tokens; a system token may be defined once (lint) and is checked on every element as rendered; custom properties, `font-variation-settings` and picked members of Other read | the reviewer's 13 (W1 to W10, W17, W23, W24) all caught; v8's own U1 to U9; the reviewer's 65 caught; @@CORPUS@@ |
| m1 stacked folded rows cost density | The row is its key link's target; the key's line and "Actions…" are drawn at their own height; the 44 px are the row's | rows measured below; U5, U6 and the hit-area guard; `compare/v8-m2-m1-folded-list-400-*` |
| m2 the audit's header names v6 | Rewritten: the latest review's compositions, every guard and context | `tools/audit.mjs` lines 1 to 44 |
| m3 a segmented control drawn taller with a coarse pointer | Drawn at its own height; a wrapped one keeps its rows apart by a gap, so the 44 px hit areas do not meet | U8 and the hit-area guard at 320 px; `compare/v8-m3-segmented-preview-*`, `images/v8-chart-controls-320-coarse-light.png` |
| Timings | The load beside every timing; every row above the stated load "not judged" | `speed/` |

@@BODY@@
