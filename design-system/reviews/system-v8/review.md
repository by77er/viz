# Review: viz design system, v8

Reviewed 2026-11-19 against `project/review.md` (v8's), by the reviewer who rejected v5, v6 and v7.
Inputs: the system on disk (commit a92bad1, as the coordinator gave it), copied to the session scratchpad, built, served and
rendered there; the compositions in `compositions/`; my own v5 to v7 findings, mutants and compositions.
As the coordinator directed, `response.md` was used only to find what changed; every claim below was
checked here. Every image cited is in `review-images/` and was rendered here.

## Verdict: reject (one blocker; no majors)

The rubric: "Reject: any blocker". There is one, and it is new in v8:

- **B1. A page that loads scrolled to a chart lands somewhere else** (Narrow and zoom: "layout shift under
  0.05 when the page loads scrolled to a region"; blocker). v8 skips charts off screen
  (`.vz-chart { content-visibility: auto }`) so that a theme change restyles less. A skipped chart is as
  tall as its reservation, and most charts on the system's own pages reserve far less than they draw.
  Reload the Chart preview while reading "CPU by pod, the query narrowed to node-b": the page shifts
  **0.81** at 400 px coarse (0.50 at 720 px, 0.18 at 1500 px), and the person lands 1,041 px away, on the
  next two panels (image `01`). With `content-visibility` switched off on the same build, and on
  v7: **0.0000**, landing in place. No check sees it: the harness measures reloads on the fixture only,
  whose charts reserve exactly, and `check.mjs` compares reserved with drawn only for charts that set
  `--legend-rows`.

Everything I rejected v7 for is fixed, and I could not break the fixes:

- **M1** (a narrowed query left the screen grey): a query narrowed to node-b now colours the eight largest
  pods on node-b, the same colours a dashboard filter gives, with the recolour offered (image `02`, panel 2).
  20 of 20 chart tests pass, and my own property check found no violation in 37,500 steps.
- **M2** (single-unit numbers left-aligned): right-aligned in both places, and the audit's new `align`
  check catches the v7 markup put back.
- **M3** (mutants surviving): all 13 of my v7 mutants are caught now, and 13 of the 17 new ones I wrote
  against v8's own guards. Four survive; they are minors (m1).
- **Timings:** for the first time, rows can be judged. The theme change, above budget in every session that measured it since v6, is fixed
  (no transition left running, judged; within budget even at a load of 6 to 8). The touch crosshair passes
  my one judged 20-run measurement at 49.6 ms against 50 (m2).

B1 is a small fix: give every chart the reservation it draws (the system's own rule), make `check.mjs` read
every chart, and reload each page with charts scrolled to a chart as part of the audit. With that, and the
minors at the author's discretion, v8 can be approved in a short round.

## How this was checked

- **Build:** a copy of `design-system/` in the session scratchpad. `npm run build` there reproduces the
  tree's generated files. `npm test`: `chart-rules.test.mjs` 20 of 20; `check.test.mjs` 113 pass, 46 skipped
  (they need a browser: `VIZ_SLOW=1`; not run here), 0 fail.
- **Colour rules:** in node, through the chart's own `chartModel`, `recolour` and `legendActions`, as the
  author's tests load them:
  - my nine sequences A to I, and the narrowing done both ways (H);
  - my property check, written from the rubric's blocker list, extended for v8 ("a series on screen is
    grey only while all eight slots are held on screen", "the recolour is offered while Other has
    members"): 3 seeds, 1,500 sequences, 37,500 steps;
  - the narrowing round trip (narrow to node-b, widen back) and "Colour the eight largest" at load.

  On the running Chart preview: the page's own segments, in four states (image `02`).
- **Folded lists:** my 40-pod list and the folded-list composition with a coarse pointer: who owns every
  point of a row at 400 px (hit tests every 4 px down and 6% across), row heights at 320 and 400 px, each
  kept column's head against its figures at 320, 400 and 560 px.
- **Overflow sweep:** 56 pages × 12 configurations = 672 loads (11 compositions, 12 flow screens, 31
  previews, the reference and mine; coarse 320 to 768 px, fine 1024 to 1500 px, 200% zoom at 720 and 750).
- **Compositions:** twelve pages (the eleven and mine) in both themes, 1500 px fine and 400 px coarse; hit
  areas at 400 px coarse (496 controls). Keyboard walks in both themes on five pages.
- **Off-screen charts:** every chart's reserved height against its drawn height on six pages at two
  layouts; reloads while scrolled to a chart (Chromium restores the position), with `content-visibility`
  on and switched off, and on the v7 copy; jumps to a chart after load; what each chart could clip.
- **Mutants**, all on copies, never in the tree:
  - my 52 v5/v6 mutants against `check.mjs`; the eight it does not catch through `tools/audit.mjs`
    (`--quick`, on a built copy, with the pages each guard needs) and `check.mjs --render`;
  - my 13 v7 mutants (W) and my control, through both tools;
  - 17 new ones (V) aimed at what v8 added (no eased colour, off-screen charts, the folded row as the
    key's target, alignment, the legend's rings, a token redefined from a page), each survivor injected
    into the running page to confirm that it breaks what it claims.
- **Speed:** `tools/speed.mjs` on the fixture, CPU 4x, Fast 4G, 20 runs a row: the touch crosshair four
  times, the theme rows once at each layout.
- **Machine:** 4 cores shared with other sessions; 1-minute load 2.7 to 13.8 during the session. Each
  timing below carries its load.

Not checked:
- a screen reader by ear, Safari and Firefox, real touch hardware;
- the author's 159-mutant corpus as a whole, the full 14-configuration audit, the theme traces;
- the flow screens beyond overflow (unchanged v5 markup, for their own revision).

## Images

| File | Shows |
|---|---|
| `01-reload-scrolled-to-a-chart-lands-1041px-away-shift-0.81-chart-preview-400-coarse.png` | The Chart preview at 400 px coarse, light, scrolled to "the query narrowed to node-b", then 2 s after a reload: v8 lands on "Request rate, change on last week" and "Memory by service" (layout shift 0.81). The same build with `content-visibility` off lands in place (0.00) (B1) |
| `02-pods-chart-load-narrowed-widened-recoloured-light-1200.png` | The 36-pod panel by its own segments: 1, at load, "Colour the eight largest" offered with nothing to change (m3); 2, the query narrowed to node-b, eight coloured (v7 M1 fixed); 3, widened back: seven of the eight largest in Other, "14 in Other are now larger than a coloured series" (the decided cost); 4, after "Colour the eight largest" |
| `03-folded-pods-98px-rows-400-coarse-light-dark.png` | My 40-pod list at 400 px coarse in both themes: 98 px a row (v7 m1: about 120) |

## My v7 findings, checked

| v7 | Now | Evidence | Guarded? |
|---|---|---|---|
| **M1** a narrowed query leaves the screen grey, no recolour | **Fixed** | Query narrowed to node-b: `1:3742c 2:2cf3f 3:13ce0 4:88986 5:07435 6:65c97 7:25140 8:239d8`, "8 coloured by size; 4 in Other"; the dashboard filter `node="node-b"` gives the same eight in the same slots (sequence H). On the page, by the new "node-b only" segment: the same (`02`, panel 2). Query edited to search pods and back, twice: every colour returns (B). Property check: no violation in 37,500 steps, including "grey only while all eight slots are held on screen" and "recolour offered while Other has members". | **Yes.** 20 of 20 chart tests here; the author reports 10 of 20 failing on v7 (not re-run). |
| **M2** "Memory, MiB" and "Restarts" left-aligned | **Fixed** | Right-aligned in the Table preview and the folded-list composition at 1500 px (the author's `compare/v8-m2-*`, and the running pages). Folded at 400 and 560 px, each kept column's head ends where its figures end (100/100, 191/191 px); at 320 px "Throttled, %" ends 5 px past its figures (Detail, not counted). | **Yes.** My V11 and V12 (the v7 markup put back in each page) are caught by the audit's `align` check at 1500 px. |
| **M3** 12 of 13 mutants survive both tools | **Fixed** | W1–W7 and W17 caught by the audit (the guards now run at both pointers and themes; a ring cut by its parent; the mouse's press; picked members on a page); W8–W10, W23 and W24 caught by `check.mjs` (custom properties, `font-variation-settings`, a token redefined); my control W15 caught (`cut`). | Mostly. New gaps: m1. |
| **m1** stacked folded rows cost density | **Fixed** | 98 px a row at 400 px coarse in my 40-pod list (`03`): 40 pods in 3,920 px, against about 4,800. The whole row is now the key's link: at 400 px every hit test across the row goes to the key except "Actions…", which lies above it (my list and the composition's monitors). | U5, U6, U10 in the author's corpus; my V7 (rows unpositioned, every link over the whole list), V8 ("Actions…" under the row's link) and V9 (the row's top padding removed) are caught by `hit-area` and `overlap`. |
| **m2** `audit.mjs` header names v6's compositions | **Fixed** | "the compositions of the latest review that has them (reviews/system-vN/compositions/, the highest N)". | — |
| **m3** segmented control 44 px tall with a coarse pointer | **Fixed** | Drawn at its own height; at 320 px its wrapped rows are kept apart so the 44 px hit areas do not meet (`images/v8-chart-controls-320-coarse-light.png`); no control under 44 px and no overlap in my 400 px scan. | U8 (author's). |
| **Timings** none could be judged | **Judged now** | See Timings. | The harness applies "most samples" strictly (a tie is not judged): seen in my runs. |

## Blocker

### B1. Off-screen charts that reserve less than they draw move the page on reload

Rubric: Narrow and zoom, "layout shift under 0.05 when the page loads scrolled to a region" (blocker).
README, Responsiveness and feedback: "Layout shift stays under 0.05 at both layouts, including a page
that loads already scrolled to a chart (as a reload does): every region reserves its final size before its
data arrives". Image `01`.

**What happens.** A chart skipped by `content-visibility: auto` takes its reserved height
(`contain-intrinsic-size: auto none` with the chart's `min-height`) until it comes near the viewport. The
`auto` remembers a drawn size only for the life of the page, so after a reload every chart above the
restored position is back at its reservation. Where that is less than the chart draws, the page above is
shorter than it was, the restored scroll position points further down, and the charts then grow as they
are drawn.

**Measured here** (load the page, scroll a chart to the top, reload, read where it is 2 s later and the
reloaded page's layout shift):

| Page, chart, layout | v8 | v8 with `content-visibility: visible` | v7 copy |
|---|---|---|---|
| Chart preview, "the query narrowed to node-b", 400 coarse | **0.81**, lands 1,041 px away | 0.0000, in place | — (panel new in v8) |
| Chart preview, "Memory by service", 400 coarse | **1.14**, lands 719 px away | 0.0000, in place | — |
| Chart preview, "Request rate, change on last week", 400 coarse | **1.69**, ends in place after the page moves | — | 0.0000, in place |
| Chart preview, "Error ratio, if this rule had existed", 400 coarse | **0.90**, ends in place after the page moves | — | 0.0000, in place |
| Chart preview, "the query narrowed to node-b", 720 px fine | **0.50**, 915 px away | — | — |
| Chart preview, the same, 1500 px | **0.18**, 915 px away | 0.0000, in place | — |
| Reference, the same panel, 400 coarse | **0.80** | 0.0000 | — |
| Charts composition, its last chart, 400 coarse | 0.046, lands 637 px lower | 0.0000 (lands 352 px lower: its charts draw after the restore) | — |
| Fixture, charts 3 and 5; dashboard composition, chart 5; 400 coarse | 0.0000, in place | — | — |

Jumping to a chart after load (as a link or a search on the page does) shows the same mechanism: on the
Chart preview, jumping to the narrowed panel shifts 0.30 with `content-visibility` and 0.0000 without;
scrolling back up from the last chart, the browser corrects the scroll position by 494 px twice to hold
the content still.

**Why the pages differ.** Reserved against drawn height, every chart, with `content-visibility` switched
off to read the drawn size (* = sets `--legend-rows`):

| Page | 1500 px | 400 px coarse |
|---|---|---|
| Fixture, dashboard, monitor | every chart *, reserved = drawn | the same |
| Chart preview | 9 of 10 reserve 265 px (one 185) and draw 210 to 1,059 | reserve 326 (one 246), draw 291 to 1,720 |
| Reference | 20 of 22 reserve 265 or 185 px and draw more | reserve 326 or 246, draw more |
| Charts composition | 4 of 4 reserve 265, draw 416 to 559 | reserve 326, draw 577 to 820 |

Before v8 this gap was invisible on these pages, because their data is drawn at load: the charts were
already at their drawn size when the browser restored the position. v8 makes it a jump.

**Why no check saw it.**
- `check.mjs`'s reservation audit: "every chart that sets --legend-rows" reserves what it draws. A chart that
  does not set it is not read. My Y16 (the reservation zeroed by a later rule) is still caught, because the
  previews that opt in are read.
- `speed.mjs`'s load-shift rows run on the fixture, where every chart opts in.
- The response's guard list for the theme work says "the charts keep their reserved height while skipped,
  and `check.mjs` confirms reserved equals drawn": true only for charts that opt in.

**Fix** (the first removes the jump; the second and third keep it from coming back):
1. Give every chart the reservation it draws: `--legend-rows` (or the chart script setting it before the
   first paint from the legend it will draw) on the Chart preview's, the reference's and the charts
   composition's charts. This is the system's own rule, and it also matters in the application, where a
   chart whose data arrives late would grow then.
2. Make `check.mjs` read every `.vz-chart` on every page it renders, and fail one with no reservation.
3. Add a reload-scrolled check to the audit (or a `load-shift` row on a page with charts that do not opt
   in): reload each page with charts scrolled to a middle chart and to the last, at both layouts, judged at
   any load as layout shift is.

## Minors

- **m1. Four of my new mutants pass every check** (AGENTS.md: a mutant that survives is reported). None
  of these is in the system today; each was confirmed by injecting it into the running page:

  | Mutant | Broken | Confirmed | Why the checks pass |
  |---|---|---|---|
  | V2b | `.vz-button { --vz-p: background-color, border-color; transition-property: var(--vz-p); transition-duration: var(--duration-slow); transition-timing-function: var(--ease) }` | the fill eases over 10 frames on hover; 85 transitions still running in the frame the theme change is drawn (fixture) | the lint's "no colour is eased" reads `transition-property` literally; the audit holds transitions still while it reads states. `speed.mjs`'s transitions row would catch it. |
  | V3 | `.vz-input { transition: border-block-end-color …, border-inline-start-color … }` (token duration and easing) | the input's bottom border eases over 10 frames on hover; 12 transitions running when the theme change is drawn (Field preview) | the lint's colour list has no logical longhands; the fixture has no input, so the transitions row would not see it either |
  | V4 | `.vz-panel .vz-chart { content-visibility: visible }` | on the fixture at 400 px, 4 of 7 charts are skipped at load; with V4 none computes `auto`, so a theme change restyles them all again | the structure check reads that the rule exists, not what a chart computes; only the theme timing row sees it, and only at a load of 4 or less |
  | V10 | `.vz-nav a { padding-inline: 0; margin-inline: 0 }` | the ring drawn inside "Explore" covers the first 2 px of the "E" (v8: 1.8 px clear) | no check reads a ring against its letters; the response says so |

  V1 and V2 (the same as V2b with the browser's default easing) were caught only because the token trace
  saw `ease`; V1b (every property eased, with token easing) is caught by the focus guard because the ring
  eases too. Fix: have the audit read each control's computed `transition-property` and duration (any
  colour longhand with a duration fails, whatever the spelling), and each chart's computed
  `content-visibility`; put an input on the fixture.
- **m2. The touch crosshair over 36 series is at its budget, with no margin.** Judged here once over the
  budget's 20 runs: p75 49.6 ms against 50 (median 43, worst 60; load 2.7 to 3.5). The author's judged
  8-run figures straddle it (45 to 55 ms in v8). Three more runs of mine, not judged (load above 4 for
  half or more of the samples): 52, 53 and 56 ms. I count the row as passing; anything the application
  adds to that path will put it over. The author's trace names the time (the pointer handler, 11 to 14 ms
  of script; the legend's figure column, 5 to 7 ms of layout); take that work before the application
  builds on it.
- **m3. "Colour the eight largest" is offered when it would change nothing** (`02`, panel 1). At load the
  eight largest are already coloured; run at load (in node, through `recolour`), it changes no colour, and
  nothing on the page would say why. The rubric now requires it "wherever a series on screen is in Other", so this is the rule
  working as written, and a question for the lead (Feedback: every response meaningful): either offer it
  only when it would change a colour, or have the note say "the eight largest are coloured".

## The lead's rule: the cost, checked

The stated cost (README, Chart, "Why this rule"): with more than eight series on screen, a series that
leaves and comes back comes back in Other, with the note and the recolour. It is acceptable under the
rubric's Many series row, which says so in terms, and the README records what would change it.

It is bigger than the filter round trip I accepted in v7, and it falls on the most common edit in Explore:
narrow the query to node-b, look, widen it back. Then seven of the eight largest pods are inside the grey
band, and the coloured lines are node-b's pods, down to one under 0.1 cores; the note says "14 in Other are
now larger than a coloured series" (`02`, panel 3). One press of "Colour the eight largest" restores the
picture (panel 4). For the lead: the evidence the README names ("how long filters and narrowed queries
stay in recorded sessions") should be gathered before the application ships; not a finding against v8.

## Timings

Measured here with `tools/speed.mjs` on the fixture page (a floor, not the application), CPU 4x, Fast 4G,
4 cores, calibration 288 to 310 ms (context only):

| Row | Layout | Runs | p75 | Median | Worst | Load (median, range) | |
|---|---|---|---|---|---|---|---|
| Crosshair by touch drag, 36 series | phone | 20 | **49.6 ms** | 43 | 60 | 3.0 (2.7 to 3.5) | **judged, within** (50) |
| the same | phone | 20 | 52 | 48 | 61 | 3.9 (3.7 to 4.6) | not judged (10 of 20 above 4) |
| the same | phone | 20 | 53 | 50 | 65 | 4.5 (3.3 to 5.5) | not judged |
| the same | phone | 20 | 56 | 52 | 72 | 5.0 (4.1 to 6.2) | not judged |
| Change theme (to dark) | phone | 20 | 83 | 76 | 110 | 6.7 (6.1 to 7.5) | not judged |
| Change theme: transitions running when drawn | phone | 20 | 0 | 0 | 0 | any | judged, within (0) |
| Change theme (to dark) | desktop | 20 | 93 | 82 | 129 | 7.3 (6.6 to 8.0) | not judged |
| Change theme: transitions running when drawn | desktop | 20 | 0 | 0 | 0 | any | judged, within (0) |

- **Theme change:** not judged here, but within budget at a load of 6 to 8, where v7 measured 145 ms (my
  v7 run, load 6.8 to 7.7); no transition left running at either layout. This agrees with the author's
  judged runs (phone 69, desktop 72 and 82 ms). I accept the row as passing.
- **Touch crosshair:** m2.
- **Layout shift on the fixture:** 0.0000 on reload at 400 px coarse here, as the author's harness says;
  elsewhere, B1.
- Other rows were not re-run; the author's judged figures for them are within budget.

## Composed screens

No regression found beyond B1:
- 0 px page overflow in 672 loads. Folding tables that still scroll: flow screens 1, 8 and 12 only (768 px
  coarse, 1024 px, 200% zoom), as the author reports.
- 496 controls at 400 px coarse across twelve pages: none under 44 px (the one my scan lists, "node-b
  overview" in the monitor composition, is a link inside a sentence, exempt), none covered, no overlap.
- Every keyboard stop ringed in both themes: my list 118 stops, folded list 96, Chart preview 84, Table
  preview 22, dashboard 67.
- Nothing inside a chart can be clipped by its new containment: no menu, popover or fixed element in any
  chart, and no control's ring or hit area reaches past a chart's box plus its clip margin, on five pages at
  two layouts. V5 (the margin cut to a hairline) is caught by the focus guard.
- Hover no longer eases (Motion now says so). It reads as crisper, not as a defect.

## Measured here

- **Colour:** sequences A to I (H: the narrowing done both ways), the round trip and the recolour at load; property check 37,500
  steps, no violation; chart tests 20 of 20.
- **Folded rows:** 98 px (my list, 400 coarse); monitors 118 to 140 px (three lines; 140 to 160 at 320);
  the key's link owns every point of its row but "Actions…" (400 px).
- **Overflow:** 672 loads, 0 px.
- **Mutants:**
  - v5/v6: 44 of 52 caught by `check.mjs` alone; Y10–Y13, Y17 and Y18 by the audit; Y16 by
    `check.mjs --render` ("reserves 0 px and draws 490.5 px"); Y15 withdrawn in v7. All valid ones caught.
  - v7: W1–W10, W17, W23, W24 and the control W15: 14 of 14 caught.
  - v8: 13 of 17 caught (V1, V1b, V2, V5–V9, V11, V12, V13r, V14, V15); V2b, V3, V4 and V10 survive (m1).
    V13 first ran on pages where "Other" is not cut; rerun on the reference (V13r), caught. V3 first ran on
    a page with no input; rerun on Field, Dialog and the dialog composition, survived.
- **Reservation and reload:** the two tables under B1.
- **Speed:** the table under Timings.

## The author's claims, checked

**Did not hold, or held only in part:**

| Claim | What I found |
|---|---|
| "Layout shift unchanged … (the charts keep their reserved height while skipped, and `check.mjs` confirms reserved equals drawn)" | True of the fixture and of charts that set `--legend-rows`. Most charts on the Chart preview, the reference and the charts composition do not, and reloads there shift 0.18 to 1.69 (B1). |
| "`check.mjs`: fails any transition of a colour (or `all`)" | Not through `var()` in `transition-property` (V2b) or through logical longhands (V3) (m1). |
| "The phone's touch crosshair … 54 ms at p75 … judged over budget" | Judged here over 20 runs: 49.6 ms, within by 0.4 ms. Both are true of the row: it sits on its budget (m2). |

**Held, checked here:** M1's fix in node and on the page; the narrowing by query and by filter giving the
same colours; the stated cost and its note; M2 and its `align` guard; every v7 mutant caught; the rows'
density; the folded row as the key's target; the segmented control at 320 px; the audit header; the theme
change (no transition left running, judged; within budget even loaded); hover drawn in the next frame;
0 overflow; hit areas and rings on the composed screens; `npm test`; the build.

**Not checked:** the 159-mutant corpus as one run, the full audit, the theme traces (restyled element
counts), the author's A/B runs.

## Housekeeping

Everything ran on copies in the session scratchpad. The tree was not edited, except this file and
`review-images/` (3 images, 0.86 MB). Servers: one static server on the v8 copy (port 8961) and, briefly,
one on the v7 copy (8962); the speed harness's and the audit's own servers stopped with them. All are
stopped. No git command was run. No Cloudflare resource was touched.
