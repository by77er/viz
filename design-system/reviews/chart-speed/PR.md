# Chart speed: a many-series result painted sooner (app-v9 review, B1)

## The third review's conditions: C5 and C4 (2026-11-28, evening)

`third-review.md` kept the waiver for 37 to 200 series, replaced R1 and R2 with R1′, R2′ and the **session rule** (SR), and
added **C5**: B1's unwaived rows met by SR on the final build. Everything here was **measured here** (this shared 4-core
machine, Chromium headless shell, CPU 4x, Fast 4G, the development mock, DevTools keeping no body copies, every browser job
under the shared lock, every run judged). Nothing was measured on a device or on Cloudflare. "final" is the merged tree as
committed (`4dea3c5`'s `app/` and `design-system/`), "new" is final with the legend change below, `c4a154b` is the anchor
of the earlier sessions; all built in the scratch area with `node_modules` linked.

| Condition | State | Result |
|---|---|---|
| **C5, desktop 36, last byte** | **Change made; met by SR (two sessions under 100); the paired gain is not beyond the noise by C1's rule** | The legend is now written only where it changed (below). Identity: 146 states, every one the same in pixels, markup, names, text form and table; a differential test of 2,480 steps. Paired against final: **−16 ms** last byte (quicker in 13 of 20), −15 ms body read (14 of 20) in session 1; −5 ms (12 of 20) and −3 ms (13 of 20) in session 2; pooled over both, −9 ms (25 of 40) and −8 ms (27 of 40). By SR, "new": session 1 **92 ms**, session 2 **99.7 ms** at the 75th percentile: **two sessions agree, met** (pooled over the 40 runs, 95.4 ms; 7 of 40 over 100) |
| **C5, phone 36, chart to table** | **Third session run: not met** | 101, 86, **107** ms; pooled over the three sessions (60 runs) **101.1 ms**, 17 of 60 over 100. Not fixed (below) |
| **C5, phone 200, chart to table** | **Third session run: not met** | 91, 127, **115** ms; pooled **103.1 ms**, 18 of 60 over 100. Not fixed (below) |
| **C4, the waiting line** | **Materials made; not judged here** | Exact-frame images (both layouts, both themes, 200 and 36 series, and a dashboard panel), the dashboards' frame records, and 20 more phone runs at 36 series with an explanation of the late removals: `waiting-line/README.md`, "C4 after the third review" |

### C5, desktop 36 series: where the legend's time went

`tools/lay.cjs` writes one part of a drawn chart again with its own markup and times the style and layout that follow
(`data/c5-layout-attribution.txt`, which also has the trace). At 36 series on the desktop, at 4x CPU: the plot's markup
costs about 4 ms of layout, **the legend's rows about 7 to 12 ms**, both together 12 to 16 ms; unthrottled 0.8, 1.6 and
2.3 ms. A trace with layout invalidation tracking shows one layout in the frame after a draw, and in it every element of
the legend (its colgroup, head, and 10 rows with their buttons, figure cells and text) removed and added again on every draw,
whatever changed.

**Why `table-layout: fixed` "did not help" on 2026-11-27:** the legend already has it (`src/components.css`, line 387:
"the script sets each figure column's width once per draw"), so the column algorithm was never the cost. Nor is any
single CSS feature: none of these moved the legend's layout outside the spread between two blocks of the same build
(7.4 and 10.8 ms): `container-type: normal` on the legend's wrap, no scroll-driven edge animation, `content-visibility:
visible`, a first column that is not sticky, `overflow: visible` or `overflow: clip` on the cells, `table-layout: auto`,
every `:has()` rule removed, every `:hover` rule removed. The cost is laying out a table whose every element is new on
every draw: parsed, styled, given layout objects, laid out with nothing cached. `contain` and `content-visibility` on rows
cannot apply (layout containment does not apply to table rows), and the legend's rows are on screen at 36 series.

### The change

`design-system/project/components/Chart/preview.html`, `legend()` (regenerated into `dist/viz-chart.js` by
`tools/build.mjs`): on a draw (a new result, a new range), the legend's four parts (column widths, head, rows, note) are
each written only when their markup differs from what was last written there, and a row is written cell by cell: a row
whose first cell (swatch, name, title) is unchanged keeps its element and has only the figure cells that changed written
again (`outerHTML`, the same parse as before). The DOM is the same as writing every part afresh. Every part is still
written afresh, as before: on the first draw, with focus anywhere in the legend (so focus is lost exactly as before), and
for a sort or "Show more" / "Hide" (their handlers do not call `legendState()` after `legend()`, so the head's words and
`aria-sort` are those of the fresh markup; a first version kept them there, and the differential test below caught it).
No token, class, markup or CSS changed. The app is unchanged.

What it saves depends on what changed. Running the same query again (the benchmark's workload: the mock returns the
same result) writes nothing in the legend. A new range of the same series (Zoom in and out, `tools/zoom.cjs`, 200 draws
per build, desktop, 36 series, CPU 4x, `data/c5-zoom-desktop.txt`) writes the figure cells only: the draw's own script
time is unchanged (median 20.5 against 20.6 ms) and the layout after it falls from 14.6 to 12.7 ms at the median (17.9 to
14.3 at the 75th percentile), 36.1 to 33.3 ms in all. **So the benchmark's gain overstates what a person gets when the
figures change**: about 3 ms then, against about 16 ms in the benchmark, where the result is the one already drawn.
Other series, or another order, write those rows whole, as before.

### Identity

- `tools/identity.cjs --full-raster --rounds 2` (`data/identity-c5.json`, `.txt`; 13:20 to 13:28 UTC), with four new
  states that exercise the new path in the app: the same query run again; zoomed in twice; zoomed in, then run again;
  Other opened, then run again. **146 states per build, final against new: identical in every state** (pixels, chart
  markup, accessible names, legend row names, text form, table; 258 charts). Same-build captures differed in no state.
  That run was of the change's first version. **Run again on the final version** (sort and Show more written afresh;
  `data/identity-c5b.json`, `.txt`; 14:06 to 14:14 UTC): 146 states, **identical in every state**, no same-build noise.
  The final version's `preview.html` is the one now in the tree.
- `legend-writes.test.cjs` (new, a differential property test): the same random sequence of results and actions (the
  same series with new figures, the same result, other series, another order, fewer series, zoom, keyboard readout,
  Escape, Show more and Hide, a sort, a row chosen, focus on a row before a new result, the other width) is played on the
  chart of both builds; after every step the chart's whole markup and the focused element must be equal. 40 seeds of 30
  steps at 900 and at 400 px: **2,480 steps, all equal** (14:03 UTC, on the final "new").
  The first version of the change failed it: after a sort it kept the head, whose words and `aria-sort` the sort's
  handler does not restate; the change now writes afresh for a sort and Show more (above).
- Mutants, on copies of `dist/` in the scratch area (`tools/legend-mutants.sh`, `data/c5-legend-writes.txt`; below under
  "Mutants"): 7 run, 7 caught in the end; one survived the test's first version and is reported there.

### The gain, paired, and the row by the session rule

**Session 1, desktop** (`data/c5-desktop-s1.json`; started 13:29 UTC, calibration 469 ms, load 0.7 to 1.7, all 80 runs
judged):

| Series | Build | Load at run start: median (range); runs at or below 4 | Body read to painted, ms | Last byte to painted, ms | Chart to table, ms |
|---|---|---|---|---|---|
| 36 | final | 1.4 (0.7 to 1.6); 20 of 20 | 85 / 90 (49 to 104; 20) | 99 / 104 (57 to 121; 20) | 73 / 85 (52 to 111; 20) |
| 36 | new | 1.4 (0.7 to 1.7); 20 of 20 | 72 / 78 (45 to 87; 20) | 84 / 92 (55 to 102; 20) | 73 / 83 (52 to 105; 20) |
| 36 | pairs: new less final | | -15; quicker in 14 of 20 | -16; quicker in 13 of 20 | +6; quicker in 8 of 20 |
| 200 | final | 1.3 (1.1 to 1.5); 20 of 20 | 81 / 94 (68 to 116; 20) | 107 / 118 (88 to 147; 20) | 65 / 82 (56 to 111; 20) |
| 200 | new | 1.3 (1.1 to 1.5); 20 of 20 | 81 / 92 (61 to 113; 20) | 107 / 121 (84 to 143; 20) | 62 / 75 (56 to 109; 20) |
| 200 | pairs: new less final | | -6; quicker in 13 of 20 | -1; quicker in 11 of 20 | +0; quicker in 9 of 20 |

**Session 2, desktop** (`data/c5-desktop-s2.json`; started 13:59 UTC, 30 minutes after session 1, calibration 321 ms, load 1.0 to 1.6, all 40 runs judged. Its "new" is the build with the sort fix above (the draw path is the same code as in session 1)):

| Series | Build | Load at run start: median (range); runs at or below 4 | Body read to painted, ms | Last byte to painted, ms | Chart to table, ms |
|---|---|---|---|---|---|
| 36 | final | 1.1 (1.0 to 1.6); 20 of 20 | 74 / 94 (54 to 114; 20) | 87 / 109 (63 to 127; 20) | 74 / 95 (53 to 108; 20) |
| 36 | new | 1.2 (1.1 to 1.6); 20 of 20 | 73 / 84 (49 to 98; 20) | 84 / 100 (59 to 115; 20) | 73 / 85 (52 to 110; 20) |
| 36 | pairs: new less final | | -3; quicker in 13 of 20 | -5; quicker in 12 of 20 | -6; quicker in 12 of 20 |

Pairs pooled over both sessions (40): last byte −9 ms, quicker in 25 of 40; body read −8 ms, 27 of 40; chart to table −1 ms, 20 of 40.

**The rows by SR** (75th percentile, ms; budget 100):

| Row | Build | Session 1 | Session 2 | By SR |
|---|---|---|---|---|
| Desktop 36, last byte | new | 92 (2 of 20 over) | **99.7** (5 of 20 over) | **two sessions agree, met** (pooled over the 40 runs, 95.4 ms; 7 of 40 over 100) |
| Desktop 36, last byte | final (anchor) | 104 (9 of 20 over) | 109 (8 of 20 over) | — (the earlier sessions: 90, 109, 104, 101; not met, the third review) |
| Desktop 36, body read | new | 78 | 84 | Met (78, 84) |
| Desktop 36, chart to table | new | 83 | 85 | Met (83, 85) |
| Desktop 200, last byte / body read | new | 121 / 92 | — | Waived; under R1′'s 170 / 140. Paired against final: −1 ms (11 of 20 quicker) and −6 ms (13 of 20): no regression by R1′ |

By C1's rule a paired shift "beyond the noise" needs a median outside ±10 ms with 15 or more of 20 pairs on its side
(the mirror of "5 or fewer quicker"). Session 1's −16 ms with 13 of 20 quicker is outside ±10 ms but not 15 of 20, so on
its own it is **not** beyond the noise by that rule; session 2 read −5 ms (12 of 20), and both sessions pooled read −9 ms with 25 of 40 quicker (63 %). **So the gain is in the right direction in both sessions but is not shown beyond the noise by C1's rule**, and the row is met by SR with 0.3 ms to spare in session 2. Both are reported as they are; the third review's C5 asks for both, and only the second is met.

### Phone, chart to table: the third session

`data/c5-phone-s3.json` (started 13:11 UTC, calibration 348 ms, load 0.7 to 2.0, all 80 runs judged), final against
`c4a154b`, 20 runs each, 36 and 200 series:

| Series | Build | Load at run start: median (range); runs at or below 4 | Body read to painted, ms | Last byte to painted, ms | Chart to table, ms |
|---|---|---|---|---|---|
| 36 | c4a154b | 1.2 (0.7 to 2.0); 20 of 20 | 83 / 86 (51 to 137; 20) | 91 / 97 (56 to 174; 20) | 83 / 107 (66 to 160; 20) |
| 36 | final | 1.2 (0.7 to 1.9); 20 of 20 | 66 / 79 (45 to 92; 20) | 75 / 90 (49 to 106; 20) | 90 / 107 (67 to 135; 20) |
| 36 | pairs: final less c4a154b | | -12; quicker in 13 of 20 | -11; quicker in 14 of 20 | +2; quicker in 8 of 20 |
| 200 | c4a154b | 1.3 (1.1 to 1.6); 20 of 20 | 118 / 124 (82 to 148; 17) | 137 / 143 (93 to 174; 20) | 97 / 106 (71 to 144; 20) |
| 200 | final | 1.2 (1.1 to 1.6); 20 of 20 | 82 / 100 (58 to 129; 19) | 98 / 113 (70 to 149; 20) | 97 / 115 (77 to 157; 20) |
| 200 | pairs: final less c4a154b | | -35; quicker in 14 of 16 | -38; quicker in 17 of 20 | +0; quicker in 9 of 20 |

| Row ("after", 75th percentile, ms) | Morning (the change alone) | C2 (final) | Third (final) | Pooled, 60 runs | By SR |
|---|---|---|---|---|---|
| Phone 36, chart to table | 101 | 86 | 107 | **101.1** (17 over 100) | **Not met** |
| Phone 200, chart to table | 91 | 127 | 115 | **103.1** (18 over 100) | **Not met** |
| Phone 36, last byte / body read (context) | 78 / 70 | 89 / 77 | 90 / 79 | 88.8 / 77.1 | Met (already decided) |

Neither is caused by the change: paired final less `c4a154b` +2 ms (8 of 20 quicker) at 36 and +0 ms (9 of 20) at 200, as
in the earlier sessions. The "before" build reads the same rows over the limit too (pooled over its three sessions 105.0
and 104.5).

**The legend change on the phone** (a fourth phone session, `data/c5-phone-new.json`: new against final, 20 runs each,
started 14:14 UTC, calibration 413 ms, load 0.5 to 2.0, all 80 runs judged):

| Series | Build | Load at run start: median (range); runs at or below 4 | Body read to painted, ms | Last byte to painted, ms | Chart to table, ms |
|---|---|---|---|---|---|
| 36 | final | 1.3 (0.5 to 1.6); 20 of 20 | 57 / 69 (42 to 84; 20) | 64 / 79 (48 to 102; 20) | 91 / 106 (64 to 144; 20) |
| 36 | new | 1.3 (0.5 to 1.7); 20 of 20 | 53 / 61 (35 to 75; 20) | 63 / 69 (44 to 91; 20) | 85 / 102 (65 to 123; 20) |
| 36 | pairs: new less final | | -9; quicker in 14 of 20 | -10; quicker in 13 of 20 | 0; quicker in 9 of 20 |
| 200 | final | 1.5 (1.3 to 1.9); 20 of 20 | 91 / 104 (60 to 118; 18) | 108 / 119 (79 to 138; 20) | 125 / 129 (93 to 151; 20) |
| 200 | new | 1.5 (1.3 to 2.0); 20 of 20 | 85 / 88 (50 to 108; 16) | 103 / 109 (67 to 133; 20) | 116 / 129 (74 to 148; 20) |
| 200 | pairs: new less final | | -8; quicker in 10 of 14 | -6; quicker in 12 of 20 | -9; quicker in 12 of 20 |

The change does not move chart to table (paired +0 ms, 9 of 20, at 36; −9 ms, 12 of 20, at 200: equal by C1's rule, so
SR lets the new build's runs pool with final's), and it leaves both rows over: 102 and 129 ms here; final read 106 and 129
in the same session, a fourth reading of an already decided row. The result's paint on the phone: paired −10 ms (13 of
20) at 36 series and −6 ms (12 of 20) at 200, none beyond the noise; the 200-series figures (109 ms last byte, 88 body
read) are inside R1′'s 130 and 115.

**Not fixed in this round.** A trace of chart to table at 200 series on the phone (`tools/profile.cjs --phone --table
--raw --inval`, 2 runs with invalidation tracking and 3 without, final, 13:44 UTC; the profiler slows the page: read the
shares) puts the time in one style recalculation of 131 elements (13 to 22 ms) and one layout (32 to 48 ms, 43 dirty of
398 objects): the new table's 50 rows (150 figure cells, 216 text nodes, an automatic table layout, a sticky first
column) and the parked chart, whose layout object is removed and made again when it is parked (`.is-parked` changes its
`position`). The candidates that change nothing a person sees (a parked state that keeps the chart's `position`; fewer
layers in the table's sticky column) were not tried: there was no time left in this round for a change, its identity
run and two more phone sessions. The rows stay **not met**; a reviewer may consider them only after a remedy has been
tried (third review, §2).

## The second review's decision, and its conditions (2026-11-28, afternoon)

**The decision** (`second-review.md`): B1 is **waived, not withdrawn**, for one budget row only, "Receives
a result: paint it … 100 ms after it arrives", in Explore, for results of more than 36 and up to 200
series, both layouts, both definitions of "arrives". It takes effect when C1 to C4 are done and lapses on
**2026-12-31 unless F1** (the system's owner decides how a many-series result meets the budget, recorded
in `design/DECISIONS.md`) is decided by then. **Not waived:** anything at 36 series or fewer; chart to
table at any size; the dashboards view; results above 200 series; the waiting-line change (C4).

**What reopens it** (the review's R1 to R6): R1, a judged alternating 20-run measurement at 200 series
over 140 / 170 ms (desktop, body read / last byte) or 115 / 130 ms (phone) at the 75th percentile; **R2,
any 36-series result paint over 100 ms at the 75th percentile in a judged session**; R3, once viz is
deployed, more than 1 in 20 Explore results with more than 100 series; R4, a mid-range phone painting a
200-series result more than 200 ms after the last byte (75th percentile); R5, F1 not decided by
2026-12-31; R6, anything shown during the extra time stops being true.

**The conditions, as they stand** (all **measured here**: this shared 4-core machine, Chromium headless
shell, CPU 4x, Fast 4G, the development mock, DevTools keeping no copy of bodies, every run under the
shared lock, every run judged: load at run start at most 2.3):

| Condition | State | Result |
|---|---|---|
| **C1** did the build before regress? | **Done: ruled out** | `c4a154b` against `cc50ea2`, 20 alternating runs, desktop, 200 series: paired −8 ms body read (quicker in 9 of 17), −12 ms last byte (12 of 20). Not slower; nothing to remove ("C1", below) |
| **C2** a second session of the final build | **Done; it fails R2** | Desktop, 36 series, from the last byte: **109 ms** at the 75th percentile (12 of 20 runs over 100; the first session read 90). Phone, 200 series, chart to table: **127 ms** (8 of 20 over; first session 91), not caused by the change (paired −4) and not covered by the waiver. Phone, 36 series, chart to table: 86 ms (101 in the first): the sessions disagree. The 200-series paints stay inside R1's bounds; desktop chart to table at 200 is inside in both (94, 93) ("C2", below) |
| **C3** what `PR.md` says | Done here | The corrections the review lists are made below (points 1 to 6 of its "What `PR.md` must change"); the pull request's description is still to say the same |
| **C4** the waiting line's frames | **Records and images made; not reviewed** | `waiting-line/` (before and after, both layouts, 36 and 200 series, and the 300 ms minimum; since the third review also the exact-frame images, the dashboards' records and 20 more phone runs at 36 series). It needs a verdict from a reviewer who did not write it |
| **C5** (third review) B1's unwaived rows by the session rule | **Desktop 36 met; phone chart to table not met** | See "The third review's conditions", above |

**So the waiver has not taken effect, and by its own R2 it would be reopened at once:** the 36-series
result paint on the desktop read over 100 ms at the 75th percentile in a judged session (109 ms from the
last byte; 97 ms from the body read, 4 of 20 over), and a third block of 20 runs, taken to check the
merge, read 101 ms for the merged tree and 104 ms for the change alone. By the review's C2: "If … any 36-series result paint
reads over 100 ms at the 75th percentile again, B1 is not resolved … It needs a fix, or a second reviewer
of its own." The same session's "before" read 140 ms there, so the change is still quicker (paired −36 ms,
17 of 20), and the merged tree is not slower than the change alone (paired +2 ms; "C2", the merge
check). No fix was tried in this round: the invisible candidates this file names (the legend table's
layout, perhaps 5 to 10 ms; the harness's own copy of the body, measured only at 200 series) were not
worked on. This is reported, not judged here.

## C1: did the build before regress?

The review's question: "before" (`c4a154b`) read about 50 ms slower at 200 series on the desktop than the
first reviewer's session on `cc50ea2`. Rule: if `c4a154b` is slower beyond the noise (a paired median
outside ±10 ms with 5 or fewer of 20 pairs quicker), find the cause.

Both commits' `app/` and `design-system/` were taken with `git archive` into the scratch area, built there
(`node tools/build.mjs`, then `vite build`) with the tree's `node_modules` linked, and measured with
`tools/ab.cjs --skip typing,crosshair,local --series 200 --runs 20` (one mock, `c4a154b`'s, for both).
The design system's chart is the same at both commits (`git diff cc50ea2 c4a154b` touches only `app/`).

**desktop**: started 2026-11-28 11:10 UTC, calibration 391 ms, 4 cores, load 0.9 to 1.6 at run start, all
40 runs judged; layout shift 0 in every run; neither DevTools session held the body in any run.
`data/c1-desktop.json`

| Series | Build | Body read to painted, ms | Last byte to painted, ms | Chart to table, ms |
|---|---|---|---|---|
| 200 | cc50ea2 (the first reviewer's) | 193 / 205 (126 to 240; 18) | 222 / 228 (146 to 271; 20) | 74 / 97 (51 to 113; 20) |
| 200 | c4a154b ("before" of this change) | 187 / 196 (121 to 229; 19) | 207 / 221 (140 to 257; 20) | 66 / 91 (57 to 115; 20) |
| 200 | pairs: c4a154b less cc50ea2 | −8; quicker in 9 of 17 | −12; quicker in 12 of 20 | +1; quicker in 9 of 20 |

**Finding: not slower.** By the rule, `c4a154b` is not slower than `cc50ea2`; if anything it is a little
quicker, within noise. Split by which build went first, the paired body read is −25 and +31 ms and the
last byte −27 and −10 ms: an order effect of the same size as the one the review found in `clone.json`,
and no sign either way. So the ~50 ms between sessions is not code that came in with the dashboards
(`7469d5a`) or the app's fixes (`aa120dc`): `cc50ea2` itself reads about 200 ms in this session, against
143 ms in the first reviewer's. Nothing was removed, and no identity run was needed. What differs between
the sessions (the machine's other work; the DevTools buffers, on in the earlier sessions, which the
review showed do not touch the body-read row) was not separated. This session's calibration task read
391 ms, against 325 to 342 ms in this morning's sessions.

## C2: the second session of the final build

"Before" is `c4a154b` (built as for C1); **"after" is the merged tree as it is now**: commit `67d9d73`'s
`app/` (this change and the monitors view), whose `app/src` is unchanged since, with the `dist/` built
from it at 11:05 UTC, copied to the scratch area so that nothing else could rebuild it during the runs.
`tools/ab.cjs --skip typing,crosshair,local --runs 20`, desktop at 36 and 200 series, phone at 4, 36 and
200 series. A cell is median / 75th percentile (lowest to highest; runs that have the figure).

**desktop**: Chromium, CPU 4x, Fast 4G, 1440x900, fine pointer, fresh context per run; builds alternated run by run; DevTools keeps no copy of response bodies. Started 2026-11-28 11:20 UTC, calibration 336 ms, 4 cores. `c2-desktop.json`

| Series | Build | Load at run start: median (range); runs at or below 4 | Body read to painted, ms | Last byte to painted, ms | Chart to table, ms |
|---|---|---|---|---|---|
| 36 | before | 1.1 (1.0 to 1.3); 20 of 20 | 116 / 127 (74 to 149; 20) | 129 / 140 (80 to 167; 20) | 69 / 88 (50 to 114; 20) |
| 36 | after | 1.1 (1.0 to 1.3); 20 of 20 | 89 / 97 (55 to 110; 20) | 104 / 109 (57 to 131; 20) | 64 / 98 (50 to 108; 20) |
| 36 | pairs: after less before | | -36; quicker in 17 of 20 | -36; quicker in 17 of 20 | +1; quicker in 9 of 20 |
| 200 | before | 1.2 (1.1 to 1.6); 20 of 20 | 133 / 180 (114 to 241; 20) | 166 / 203 (135 to 280; 20) | 72 / 95 (53 to 115; 20) |
| 200 | after | 1.2 (1.1 to 1.6); 20 of 20 | 100 / 125 (69 to 137; 14) | 124 / 153 (74 to 174; 20) | 61 / 93 (54 to 125; 20) |
| 200 | pairs: after less before | | -50; quicker in 13 of 14 | -43; quicker in 18 of 20 | -8; quicker in 14 of 20 |

**phone**: Chromium, CPU 4x, Fast 4G, 400x800, coarse pointer, touch, device scale 2, fresh context per run; builds alternated run by run; DevTools keeps no copy of response bodies. Started 2026-11-28 11:50 UTC, calibration 346 ms, 4 cores. `c2-phone.json`

| Series | Build | Load at run start: median (range); runs at or below 4 | Body read to painted, ms | Last byte to painted, ms | Chart to table, ms |
|---|---|---|---|---|---|
| 4 | before | 1.2 (1.0 to 1.4); 20 of 20 | 37 / 43 (32 to 75; 20) | 43 / 54 (38 to 85; 20) | 64 / 80 (42 to 89; 20) |
| 4 | after | 1.2 (1.0 to 1.5); 20 of 20 | 40 / 52 (33 to 70; 20) | 51 / 65 (39 to 83; 20) | 62 / 70 (44 to 89; 20) |
| 4 | pairs: after less before | | +1; quicker in 8 of 20 | +4; quicker in 6 of 20 | -4; quicker in 11 of 20 |
| 36 | before | 1.1 (1.0 to 1.9); 20 of 20 | 70 / 91 (52 to 114; 20) | 76 / 100 (59 to 131; 20) | 82 / 96 (65 to 130; 20) |
| 36 | after | 1.1 (1.0 to 1.8); 20 of 20 | 65 / 77 (42 to 93; 20) | 72 / 89 (47 to 103; 20) | 80 / 86 (66 to 131; 20) |
| 36 | pairs: after less before | | -4; quicker in 11 of 20 | -3; quicker in 11 of 20 | +1; quicker in 9 of 20 |
| 200 | before | 1.5 (1.3 to 2.2); 20 of 20 | 91 / 103 (81 to 144; 15) | 111 / 124 (94 to 169; 20) | 92 / 104 (71 to 162; 20) |
| 200 | after | 1.5 (1.3 to 2.2); 20 of 20 | 89 / 101 (56 to 130; 18) | 109 / 122 (70 to 152; 20) | 92 / 127 (70 to 181; 20) |
| 200 | pairs: after less before | | -3; quicker in 8 of 15 | +1; quicker in 9 of 20 | -4; quicker in 11 of 20 |

Every run of both layouts started at a load at or below 4 (the most was 2.3), so every row is judged;
layout shift from the press to the settled result was 0 in all 200 runs; neither DevTools session held the
body in any run. Calibration 336 ms (desktop) and 346 ms (phone).

**The rows the review named, from the two sessions together** ("after", 75th percentile, ms; budget 100;
the first session is the morning's `ab-desktop.json` and `ab-phone.json`, on the change alone):

| Row | First session | Second session | Runs over 100 (first; second) | Reading |
|---|---|---|---|---|
| **Desktop, 36 series, last byte** | 90 | **109** | 4; 12 of 20 | **Over in the second session.** R2 of the waiver; "B1 is not resolved" by C2 |
| Desktop, 36 series, body read | 80 | 97 | 1; 4 of 20 | Inside in both; within a tenth of the limit in the second |
| Phone, 36 series, chart to table | **101** | 86 | 6; 3 of 20 | Over in the first, inside in the second: the two sessions do not agree, so it is not settled either way |
| Desktop, 200 series, chart to table | 94 | 93 | 3; 1 of 20 | Inside in both (thin): the two sessions agree |
| **Phone, 200 series, chart to table** | 91 | **127** | 1; 8 of 20 | **Over in the second session** (before: 104, paired −4 ms). Not caused by the change and not covered by the waiver ("Chart to table at any size") |
| Desktop, 200 series, body read | 127 | 125 (14 runs; with the 6 missing filled in from their last byte, 125) | — | Over; waived; under R1's 140 |
| Desktop, 200 series, last byte | 156 | 153 | — | Over; waived; under R1's 170 |
| Phone, 200 series, body read | 101 (17 runs; filled in, 101 to 104) | 101 (18 runs; the 2 missing rank 16 and 17 of 20 by last byte; filled in, 105) | — | Over; waived; under R1's 115 |
| Phone, 200 series, last byte | 118 | 122 | — | Over; waived; under R1's 130 |
| Phone, 36 series, result paint | 70 / 78 | 77 / 89 | 0, 2; 0, 2 of 20 | Inside in both |
| Desktop, 36 series, chart to table | 59 | 98 | 1; 2 of 20 | Inside in both; within a tenth of the limit in the second (not a row the review named) |

**Other things this session shows.**

- **At 4 series on the phone "after" is a little slower again**: paired +1 ms (body read) and +4 ms (last
  byte), quicker in 8 and 6 of 20 (the first session: +1 and +4, 8 and 8 of 20); 75th percentiles 43 to 52
  and 54 to 65 ms. Two sessions now agree on a few milliseconds' cost, 35 ms inside the budget. Its cause
  was not looked for.
- **At 200 series on the phone the change gained nothing in this session**: paired −3 ms body read (8 of
  15 quicker) and +1 ms last byte (9 of 20), against −20 and −15 ms in the first. On the desktop it gained
  −50 and −43 ms (13 of 14, 18 of 20), and at 36 series −36 ms both ways (17 of 20).
- **This session read slower than the first for both builds at 36 series on the desktop** (before: 127 /
  140 here, 113 / 127 there): the change kept its gain, and the absolute figure moved with the session by
  about the noise between blocks. That is how a row at 90 ms became 109 ms.

**The merge, checked**: the merged tree against the change alone (`a3ba07d`'s `app/`, the author's
`b1/after` build, whose source equals `a3ba07d`), alternated, desktop, 36 series, 20 runs:
started 12:01 UTC, load 0.9 to 1.4, all 40 runs judged. `data/merge-desktop.json`

| Series | Build | Body read to painted, ms | Last byte to painted, ms | Chart to table, ms |
|---|---|---|---|---|
| 36 | a3ba07d (the change alone) | 79 / 89 (59 to 138; 20) | 91 / **104** (67 to 156; 20) | 64 / 80 (48 to 100; 20) |
| 36 | final (the merged tree) | 84 / 89 (57 to 104; 20) | 96 / **101** (67 to 120; 20) | 71 / 94 (53 to 112; 20) |
| 36 | pairs: final less a3ba07d | +4; quicker in 8 of 20 | +2; quicker in 8 of 20 | +12; quicker in 8 of 20 |

By C1's rule the merge did not make Explore slower beyond the noise (paired +4 and +2 ms, 8 of 20
quicker). Chart to table reads +12 ms with 8 of 20 quicker, and +18 / −3 ms split by which build went
first: an order effect, not a shift by that rule. **This third block reads the desktop's 36-series last
byte over 100 ms at the 75th percentile for both builds** (101 and 104 ms): the second session's 109 ms
was not a stray block. The monitors view adds no work to Explore's result path (its changes outside
`src/monitors/` are a route, a navigation link and command, Help text, a client method and three
optional fields of the chart's spec).

## Where it stands, 2026-11-28 (morning; the first session)

This replaces the account paused on 2026-11-27 (its tables are not comparable with these: see "The
measuring method"). Everything below was **measured here**: this shared 4-core machine, Chromium
headless shell under Playwright, CPU slowed 4x, Fast 4G, the development mock on localhost, every
heavy job under the shared machine lock (so no other browser ran during a timing run); the 1-minute
load is given with every figure.

1. **The harness no longer measures itself.** DevTools no longer keeps a copy of the response body
   during timed runs; every run checks that it did not. On 4 series the old and new method agree
   within noise; at 200 series the new one reads 74 ms less "from the last byte" (paired median, 19 of 20
   pairs quicker; below, "The measuring method").
2. **The change** does the per-value work once, while the body downloads (each series is put on the
   time grid by the parser as soon as it has been read), hands the chart the result's own typed
   arrays (D76: the chart takes a `Float64Array` with NaN for a gap, as well as its first form), and
   keeps the earlier chart and waiting-line patches.
3. **Identity is shown.** Chart markup, accessible names, legend row names, text form and table are
   the same before and after in all 102 states; screenshots are bit-identical too once Chromium
   rasterises whole layers (the earlier stray pixels were partial raster, and they occurred
   between two captures of one build as often as between builds).
4. **The result's paint met the budget in this session** at 4, 12 and 36 series on both layouts by both
   definitions, and chart to table at 200 series on the phone was inside (91 ms, near the limit). **Chart
   to table on the phone at 36 series did not: 101 ms** at the 75th percentile (6 of 20 runs over 100), a
   Speed failure by the rubric's measure, not caused by this change (113 ms before), not covered by the
   waiver, and measured again in the second session (86 ms there: "C2"). **At 200 series the paint is
   over**: the 75th percentile is 127 ms (body read) and 156 ms (last byte) on the desktop, 101 and
   118 ms on the phone, down from 190 / 218 and 106 / 125 (paired medians −59 / −61 ms on the desktop,
   −20 / −15 ms on the phone). The phone's 101 ms body read is from 17 runs: the 3 runs without the
   figure are among the slowest by last byte (ranks 14, 15 and 19 of 20), and filled in from their last
   byte less the median gap the 75th percentile is 101 to 104 ms. (As context only, since the budget is
   the 75th percentile: the phone's medians were 79 and 95 ms.)
5. So a **waiver request** for the 200-series rows is at the end, with what a person sees and what
   would meet the budget.

**Which rows meet the budget** (75th percentile of 20 alternating runs, ms; budget 100; every run
judged; "after" is the change):

| Row | Desktop 4 | Desktop 12 | Desktop 36 | Desktop 200 | Phone 4 | Phone 12 | Phone 36 | Phone 200 |
|---|---|---|---|---|---|---|---|---|
| Body read to painted, before | 62 | 84 | **113** | **190** | 43 | 80 | 86 | **106** |
| Body read to painted, after | 40 | 71 | 80 | **127** | 50 | 64 | 70 | **101** |
| Last byte to painted, before | 71 | 92 | **127** | **218** | 58 | 87 | 100 | **125** |
| Last byte to painted, after | 46 | 80 | 90 | **156** | 65 | 70 | 78 | **118** |
| Chart to table, before | 37 | 61 | 87 | 98 | 66 | 83 | **113** | 88 |
| Chart to table, after | 42 | 63 | 59 | 94 | 71 | 82 | 101, over by 1 | 91 |

Bold is over. Rows within a tenth of the limit (phone 200 body read after, 101; chart to table at 200,
94 and 91; phone 36 chart to table after, 101; desktop 36 last byte after, 90) needed a second session
by the review's rule, **because two blocks of 20 runs of one build differ here by about that much**: at
4 series the 75th percentiles of one build measured twice in `method.json` differ by 7 to 10 ms in all
three rows (chart to table included, which has no network in it), and at 200 series rows that the change
under test could not touch differ by about 20 ms (chart to table: 98 against 77 in `method.json`, 75
against 98 in `clone.json`). So a 75th percentile within about 10 ms of 100 cannot be called from one
session. The second session is under "C2", below.

## The measuring method (the lead's decision 1)

**What changed.** `app/e2e/measure.cjs` and `tools/ab.cjs` enable the DevTools Network domain, for
the network shaping, with no body buffer (`Network.enable {maxTotalBufferSize: 0,
maxResourceBufferSize: 0}`), in their own session and in Playwright's own session for the page
(which Playwright enables for every page; it is not a public interface, so if it cannot be reached
the run stops instead of measuring with the buffer). With the buffers, each of the two agents kept
a copy of the body and decoded it on the page's main thread when the load finished (about 70 ms for
the 3.4 MB of 200 series at 4x CPU, found in the trace on 2026-11-27), work no browser without
DevTools open does. `--buffer` keeps the old way. The rows are otherwise defined as before: "from
the last byte" is Resource Timing's `responseEnd` of the query to the end of the last frame of the
result's burst of changes; "body read" is from when the harness's own copy of the body
(`res.clone().text()`) has been read.

**How it is checked.** Every run asks both DevTools sessions for the query's body afterwards
(`Network.getResponseBody`, and Playwright's `response.body()`): with the buffers both give it, without
them neither does, and a run in which either does stops with an error. In the runs below: with the buffers (`--buffer`) both sessions held the body in all 40 of 40 runs; without them neither did, in every one of the 40 runs of the method check without them, the 20 of the check of the harness's copy and the 320 runs of the comparison.

**The two methods on one build, alternated run by run** (the build before the change, 20 runs each):

| Series | Method | Load at run start: median (range); runs at or below 4 | Body read to painted, ms | Last byte to painted, ms | Chart to table, ms |
|---|---|---|---|---|---|
| 4 | with the buffers | 1.8 (1.2 to 2.3); 20 of 20 | 50 / 57 (40 to 74; 20) | 57 / 71 (45 to 91; 20) | 37 / 47 (26 to 59; 20) |
| 4 | without | 1.8 (1.3 to 2.4); 20 of 20 | 50 / 66 (37 to 79; 20) | 55 / 79 (41 to 92; 20) | 43 / 57 (34 to 70; 20) |
| 4 | pairs: without less with | | +0; quicker in 9 of 20 | −2; quicker in 11 of 20 | +6; quicker in 6 of 20 |
| 200 | with the buffers | 2.2 (1.6 to 3.9); 20 of 20 | 154 / 168 (114 to 216; 18) | 267 / 286 (194 to 332; 20) | 65 / 98 (49 to 122; 20) |
| 200 | without | 2.3 (1.6 to 3.5); 20 of 20 | 149 / 194 (119 to 220; 18) | 173 / 225 (141 to 251; 20) | 67 / 77 (55 to 95; 20) |
| 200 | pairs: without less with | | +5; quicker in 7 of 16 | −74; quicker in 19 of 20 | −7; quicker in 10 of 20 |

Desktop layout, started 2026-11-28 09:37 UTC, calibration 342 ms, 4 cores. `data/method.json`.

**Reading.** On 4 series the two methods agree within noise: medians 50 and 50 ms (body read), 57 and
55 ms (last byte), paired differences +0 and −2 ms, quicker in 9 and 11 of 20; the 75th percentiles
(57 against 66, 71 against 79) differ by less than the spread of either. At 200 series the body read
row is unchanged (paired +5 ms, quicker in 7 of 16), which is consistent with DevTools decoding its
copies before the harness's own copy resolves (not checked in a trace this time). The last byte row falls by 74 ms in the pairs (median 267 to 173 ms,
quicker in 19 of 20): that is the DevTools work, and it is now out of every figure below. Earlier
figures, the review's and 2026-11-27's included, are not comparable with these.

**The harness's own copy of the body** (`res.clone()`, which the "body read" row needs) was checked
the same way: 10 alternating runs at 200 series on the build before, with and without
it (`--noclone`), last byte to painted: 158 / 201 with the copy, 149 / 161 without, paired −19 ms,
quicker in 8 of 10. So the harness's own copy also costs something after the last byte at 200 series
(its decoding of 3.4 MB on the page's main thread), about 10 to 20 ms on 10 runs: **not removed** here,
because the "body read" row is defined by that copy, and both rows come from one run. It weighs on both
builds alike; it is in "Open items". At 4 to 36 series it was not measured (the body is a tenth of the
size or less).

**The system's README** does not say how "from the last byte" is taken, so no sentence there needed
correcting. For the reviewer: `design-system/tools/speed.mjs` also enables the Network domain with
its buffers on (line 118); its "arrives" is when its own copy of the body has been read, so the same
cost may sit in its figures for large bodies. Not changed here (it is the system's tool, outside this
change); recorded under "Open items".

## What changed

**App** (`app.patch`, against the shared tree's `app/` as it is now):

1. `api/matrix.ts`, `api/client.ts`, `lib/series.ts`: `MatrixParser` takes the query's grid, and puts
   each series on it (`placeOnGrid`, the code `alignSeries` ran, moved into one function both call) in
   the piece of the body that ends that series, so the work is done while the rest downloads.
   `alignSeries` uses a series' placement only when its start, end and step are exactly the query's,
   and otherwise places it itself, as before; an off-grid sample still sends the whole result down the
   general path.
2. `charts/spec.ts`, `charts/systemChart.ts`, `explore/ExplorePage.tsx`: `toSpec(…, typed: true)` hands
   the chart the result's own `Float64Array`s (NaN for a gap; a copy only when the unit is scaled).
   Explore uses it; the dashboards keep the first form.
3. `explore/waiting.tsx` (the earlier `app.patch`): the waiting line goes in the render that shows the
   result, so a wait over 400 ms no longer renders the page twice and leaves the line over the new
   result for one more frame. **This changes one frame a person can see** (the line is gone one frame
   sooner); it needs the app's reviewer.
4. `e2e/measure.cjs`: the harness change above.
5. Tests: `api/matrixGrid.test.ts` (400 random bodies, cut into random pieces, on and off the grid,
   with gaps, NaN, ±Inf, and a stale grid: `alignSeries` gives the same with and without the parser's
   placement), `charts/typedSpec.test.ts` (300 random results in six units: the typed form is the first
   form with NaN for null, and is the result's own array when not scaled). `spec.test.ts` is untouched.

**Design system** (`design-system/project/components/Chart/preview.html`, the source of
`dist/viz-chart.js`):

1. `windowOf` (new): a series' window, in either form (D76). A typed series with no gap in the window is
   a view of the caller's array (no copy); one with a gap becomes the first form, with null for each gap.
   Everything after reads one form.
2. The earlier `chart.patch`: indexed loops for a series' figures; the Other band gathered series by
   series into two `Float64Array`s; every x position written as text once per draw; the band's edges
   reusing the y text of its area; text widths cached per font. Same path text, character for character.

No token, class, markup or CSS. `design/DECISIONS.md` D76 records the interface change.

## Identity

`tools/identity.cjs`, 102 states per build: Explore at 4, 36 and 200 series, light and dark, 1440 px
and 400 px (touch, device scale 2), at rest, with a keyboard readout, with a pointer readout (1440
only), zoomed in, with Other opened, with a legend row chosen, as table and as text; and the design
system's own Chart preview and fixture pages in the same themes and widths, at rest and with a
keyboard readout on every chart. Per state: SHA-256 of a full-page screenshot and of every chart's
markup, the charts' accessible names, the legend rows' names, the text forms, the table. Every build is
captured twice, in turn; a state's pixels match when some capture of one build equals some capture of
the other bit for bit; everything else must be equal in every capture.

**Run 1, the browser as every other tool runs it** (`data/identity.json`, `data/identity.txt`; 2
captures per build, 09:08 to 09:14 UTC):

- **Chart markup, accessible names, legend row names, text form, table: the same before and after in
  all 102 states**, and the same in every capture of each build. (The fixture page's time stamp,
  `data-for`, is left out of the markup hash, as is the result's age from the screenshots.)
- **Screenshots: 101 of 102 states match.** The one that does not, "app 4 series, light, 1440 px, a
  legend row chosen", differs in 6 pixels, by 1 in one channel, between the plot's left and right
  edges (`tools/pixdiff.py`). Two captures of the *same* build were not the same image in 8 states
  (before) and 11 (after), all of them Explore at 4 series and 1440 px, and all after the first redraw
  (readouts, zoom, a chosen row, table, text): the same kind of difference, with the same markup.
- **The cause is partial raster.** With the same markup, Chromium repaints only the region that
  changed (the crosshair, a row, the plot after a zoom) and rasterises it on its own; a path edge that
  crosses the region's border is antialiased one level differently from the same edge drawn whole. So
  which pixels differ depends on what was repainted before the capture, not on the build. The 5 stray
  pixels of 2026-11-27 were this.

**Run 2, the noisy states again, 3 captures per build, with and without whole-layer raster**
(`--full-raster`, Chromium's `--disable-partial-raster`; `data/identity-4-partial.*`,
`data/identity-4-full.*`, 09:35 to 09:37 UTC; the 14 states of Explore at 4 series, 1440 px):

| Raster | States whose captures differed, before | …, after | Before vs after |
|---|---|---|---|
| partial (the default) | 8 of 14 | 6 of 14 | identical (some capture of each matches) |
| whole layers | **0 of 14** | **0 of 14** | **identical, every capture bit for bit** |

**Run 3, all 102 states with whole-layer raster, 2 captures per build** (`data/identity-full-raster.json`,
`.txt`, 09:54 to 10:00 UTC): **before and after identical in every state: pixels, chart markup,
accessible names, legend row names, text form, table** (214 charts in the states). Same-build captures
differed in one state (before: "app 200 series, light, 1440 px, Other opened"), one of whose two images
is the after build's, bit for bit; it was not looked into further. Every light image differs from its
dark one (the themes were applied). The comparison images are not committed: there is no difference
to show.

`model-equivalence.test.mjs`: the chart's model, colour map and text form are the same before and
after over 600 random results (first test), and the same for the typed form as for the first form over
600 more (second test).

## Before and after

`tools/ab.cjs`: the two builds taken in turn, run by run (before, after; after, before; …), 20 runs
each, in one session per layout, the typing, crosshair and other local steps left out. A cell is
median / 75th percentile (lowest to highest; runs that have the figure). Budget: 100 ms. "Before" is
the shared tree's `app/` and `design-system/` at commit `c4a154b`; "after" is that plus both patches.
"Pairs" is the median of (after less before) over runs taken one after the other, and in how many
pairs after was quicker. The "body read" figure is taken only when the harness's copy of the body
resolves before the result's first change to the page; the count of runs behind each cell says how
often.

**desktop**: Chromium, CPU 4x, Fast 4G, 1440x900, fine pointer, fresh context per run; builds alternated run by run; DevTools keeps no copy of response bodies. Started 2026-11-28 09:19 UTC, calibration 325 ms, 4 cores. `ab-desktop.json`

| Series | Build | Load at run start: median (range); runs at or below 4 | Body read to painted, ms | Last byte to painted, ms | Chart to table, ms |
|---|---|---|---|---|---|
| 4 | before | 1.2 (1.2 to 1.6); 20 of 20 | 53 / 62 (37 to 77; 20) | 58 / 71 (40 to 86; 20) | 33 / 37 (31 to 50; 20) |
| 4 | after | 1.3 (1.1 to 1.5); 20 of 20 | 37 / 40 (34 to 64; 20) | 42 / 46 (38 to 78; 20) | 36 / 42 (29 to 72; 20) |
| 4 | pairs: after less before | | -12; quicker in 19 of 20 | -10; quicker in 17 of 20 | +2; quicker in 8 of 20 |
| 12 | before | 1.2 (1.0 to 1.9); 20 of 20 | 73 / 84 (61 to 120; 20) | 80 / 92 (64 to 128; 20) | 48 / 61 (36 to 82; 20) |
| 12 | after | 1.3 (1.1 to 2.0); 20 of 20 | 60 / 71 (50 to 108; 20) | 67 / 80 (56 to 115; 20) | 54 / 63 (41 to 79; 20) |
| 12 | pairs: after less before | | -10; quicker in 14 of 20 | -10; quicker in 14 of 20 | +5; quicker in 9 of 20 |
| 36 | before | 1.3 (1.1 to 2.0); 20 of 20 | 94 / 113 (71 to 142; 20) | 108 / 127 (80 to 158; 20) | 61 / 87 (49 to 96; 20) |
| 36 | after | 1.3 (1.1 to 1.8); 20 of 20 | 70 / 80 (55 to 109; 20) | 82 / 90 (63 to 122; 20) | 55 / 59 (50 to 101; 20) |
| 36 | pairs: after less before | | -29; quicker in 18 of 20 | -32; quicker in 18 of 20 | -6; quicker in 12 of 20 |
| 200 | before | 1.8 (1.3 to 2.7); 20 of 20 | 164 / 190 (96 to 223; 20) | 192 / 218 (115 to 252; 20) | 75 / 98 (49 to 135; 20) |
| 200 | after | 1.8 (1.2 to 2.8); 20 of 20 | 110 / 127 (76 to 145; 18) | 136 / 156 (98 to 174; 20) | 67 / 94 (57 to 105; 20) |
| 200 | pairs: after less before | | -59; quicker in 17 of 18 | -61; quicker in 19 of 20 | -4; quicker in 14 of 20 |

**phone**: Chromium, CPU 4x, Fast 4G, 400x800, coarse pointer, touch, device scale 2, fresh context per run; builds alternated run by run; DevTools keeps no copy of response bodies. Started 2026-11-28 10:06 UTC, calibration 326 ms, 4 cores. `ab-phone.json`

| Series | Build | Load at run start: median (range); runs at or below 4 | Body read to painted, ms | Last byte to painted, ms | Chart to table, ms |
|---|---|---|---|---|---|
| 4 | before | 1.2 (0.9 to 1.6); 20 of 20 | 37 / 43 (29 to 61; 20) | 43 / 58 (32 to 78; 20) | 63 / 66 (48 to 88; 20) |
| 4 | after | 1.1 (0.9 to 1.3); 20 of 20 | 41 / 50 (31 to 68; 20) | 54 / 65 (35 to 81; 20) | 66 / 71 (40 to 87; 20) |
| 4 | pairs: after less before | | +1; quicker in 8 of 20 | +4; quicker in 8 of 20 | -1; quicker in 10 of 20 |
| 12 | before | 1.0 (0.7 to 1.5); 20 of 20 | 76 / 80 (44 to 89; 20) | 82 / 87 (48 to 96; 20) | 72 / 83 (49 to 93; 20) |
| 12 | after | 1.0 (0.8 to 1.5); 20 of 20 | 57 / 64 (40 to 72; 20) | 63 / 70 (43 to 79; 20) | 70 / 82 (50 to 128; 20) |
| 12 | pairs: after less before | | -17; quicker in 15 of 20 | -18; quicker in 14 of 20 | -4; quicker in 12 of 20 |
| 36 | before | 1.1 (0.8 to 1.4); 20 of 20 | 74 / 86 (57 to 109; 20) | 82 / 100 (63 to 120; 20) | 87 / 113 (73 to 125; 20) |
| 36 | after | 1.1 (0.8 to 1.3); 20 of 20 | 60 / 70 (42 to 91; 20) | 69 / 78 (48 to 103; 20) | 84 / 101 (65 to 124; 20) |
| 36 | pairs: after less before | | -18; quicker in 16 of 20 | -19; quicker in 15 of 20 | -9; quicker in 11 of 20 |
| 200 | before | 1.3 (1.0 to 1.5); 20 of 20 | 98 / 106 (78 to 137; 18) | 114 / 125 (88 to 163; 20) | 84 / 88 (75 to 126; 20) |
| 200 | after | 1.2 (1.0 to 1.4); 20 of 20 | 79 / 101 (53 to 128; 17) | 95 / 118 (64 to 139; 20) | 82 / 91 (72 to 123; 20) |
| 200 | pairs: after less before | | -20; quicker in 12 of 15 | -15; quicker in 15 of 20 | -4; quicker in 11 of 20 |

Every run of both layouts started at a load at or below 4 (the most was 2.8), so every row is judged by
the README's rule. The "before" figures read higher here than on 2026-11-27 for desktop 200 (190 against
135 ms at the 75th percentile, body read): "before" is now commit `c4a154b`, which carries the app's
fixes for the second review (`aa120dc`), and the earlier session ran on `0aa0f7a`. **C1 (below, "C1:
did the build before regress?") ruled the code out**: alternated in one session, `c4a154b` is not
slower than `cc50ea2`, the build the first reviewer measured (and `0aa0f7a` lies between the two);
both read about 200 ms there. So the difference between sessions is not a commit's; what does
differ between those sessions (the machine's other work, the DevTools buffers then on) was not
separated.

**No regression on a small result**, with one exception to watch: at 4 series on the phone "after" read
a little slower (pairs +1 ms body read, +4 ms last byte, quicker in 8 of 20 each; 75th percentiles 43 to
50 and 58 to 65), inside the budget by 35 ms and inside the spread of either build. On the desktop at 4
series after was quicker (−12 and −10 ms, 19 and 17 of 20).

## Chart to table at 200 series on the phone

Not changed by this work, and **inside the budget in this session**: 84 / 88 ms before and 82 / 91 after
(median / 75th percentile, 20 runs each, load 1.0 to 1.5, paired −4 ms). The review read 114 to 122 ms
and the paused session 96 and 98, so this row moves with the machine more than any other, and at 91
it is within a tenth of the limit: it needs a second session before it is called a pass. The profile
of 2026-11-27 put it in the browser's style (14 ms) and layout (27 ms) of the table and the page around
it as the chart is parked, with React's rendering of the table's 50 rows 11 ms; the profile after (`data/prof-after-phone-table.txt`, 5 runs under the profiler,
median 135 ms there) reads the same: script 37 ms (React's table 5), layout 30, style 18, paint and
pre-paint 14.
Nothing cheap was found: the fixes would be in the table's markup or CSS (which needs its own identity
proof and the app's reviewer), or showing fewer rows first, which a person would see.

## The profile after

`tools/profile.cjs --nobuffer` on an unminified build of "after" (so functions have names; it runs
slower than the measured build and the profiler adds to that: read the shares, not the totals), median
of 5 runs, 10:46 to 10:48 UTC, load 0.1 to 1.0. Full output: `data/prof-after-desktop.txt`,
`data/prof-after-phone.txt`, `data/prof-after-phone-table.txt`.

| From the body read to painted, ms under the profiler | Desktop 36 | Desktop 200 | Phone 200 |
|---|---|---|---|
| **Total** (median of 5) | 124 | 161 | 79 |
| Script (timeline `FunctionCall`) | 69 | 101 | 51 |
| of which unattributed native work (`(program)`: mostly the browser's own work inside script, the chart's `innerHTML` and the reads of layout) | 42 | 46 | 33 |
| of which the chart's plot markup (`drawPlot`, `path`, `lineMarkup`, `bandMarkup`, `xText`, `y`) | 26 | 24 | 7 |
| of which the chart's model (`chartModel` and its per-series loop, `windowOf`, `key`, `model`) | 5 | 22 | 3 |
| of which the legend (`legend`, `otherW`) | 7 | 9 | 2 |
| of which a forced layout (`get clientWidth` at the start of a draw) | 1 | 5 | 2 |
| of which garbage collection | 5 | 8 | 1 |
| of which the app's grid (`alignSeries`, `seriesKey`, `seriesName`) | 1 | 5 | 2 |
| Browser: layout | 23 | 25 | 16 |
| Browser: parse of the chart's markup | 8 | 8 | 3 |
| Browser: paint, pre-paint, layerise, style | 10 | 12 | 8 |

Against the profile before (`data/2026-11-27/prof-before-desktop.txt`, desktop 200: 165 ms under the
profiler, `alignSeries` 14, `toSpec` 14, the model 26, plot markup 22, legend 10, GC 17): the app's two
passes are gone from this window (`alignSeries` is 1 ms: the placement happens while the body
downloads), `toSpec` is gone, collection is halved. What is left at 200 series on the desktop is the
chart's drawing itself (markup about 24 ms and the native work of `innerHTML` and its parse), the model
(about 20 ms: the per-series figures over 144,000 values, the keys of 200 series and the colour map),
the legend (9) and the browser's layout (25). The two sessions' profiles were taken at different loads
(4.5 there, 0.3 here) and on different commits, so only the shares compare.

## What did not help, and what was not tried

Tuning steps, each measured; the ones that did nothing are kept.

| Step | How it was measured | Result | Kept |
|---|---|---|---|
| (2026-11-27) Indexed loop for a series' figures, in place of `for … of` | `tools/micro.cjs`: 200 x 721 values in a page at 4x CPU, the loop's second run | 10.6 ms to 3.8 ms (later runs: about 5 either way) | yes |
| (2026-11-27) The band series by series into typed arrays | same | 10.6 ms to 0.9 ms | yes |
| (2026-11-27) x text once per draw | same, 8,652 points | 9.4 ms to 6.7 ms on the second run | yes |
| (2026-11-27) Text-width cache without a concatenated key | not measured alone | no measurable change | yes: it only removes work |
| (2026-11-27) Waiting line hidden in the result's render (app) | frames after the result | 3 changes in 2 frames became 2 in 1 | yes |
| (2026-11-27) `Array.from(typed)`, spread, `slice.call` for the copy in `toSpec` | `tools/micro.cjs` | 16 to 33 ms against 5 ms for the loop | no: slower |
| (2026-11-27) `v - v === 0` for `Number.isFinite` there | same | inside the noise | no |
| (2026-11-27) `vector-effect: none`, `table-layout: fixed` on the legend, `content-visibility: visible` | layout time of the result's frame | no effect, or inside the noise of 3 runs | no |
| (2026-11-28) Each series put on the grid in the parser, as it is read | `ab.cjs`, alternating, together with the next step | see the tables | yes |
| (2026-11-28) Typed arrays through the chart's interface (D76) | same | see the tables | yes |
| (2026-11-28, C5) On the legend's wrap: `container-type: normal`; no scroll-driven edge animation; both | `tools/lay.cjs`, the legend's rows written again, layout after it, 11 rounds at 4x CPU | 13.9, 10.7, 10.9 ms against 7.4 to 11.8 for the same build | no: inside the noise (and both are visible at other widths) |
| (2026-11-28, C5) `content-visibility: visible` on the chart; first column not sticky; cells `overflow: visible`; `table-layout: auto` | same | 9.7, 9.6, 8.9, 8.0 ms | no: inside the noise |
| (2026-11-28, C5) Every `:has()` rule removed; every `:hover` rule removed | same | 9.5, 10.8 ms | no: inside the noise (diagnostic only) |
| (2026-11-28, C5) `overflow: clip` in place of `hidden` on the legend's cells, names and note | same, unthrottled, 41 rounds | 1.8 against 1.6 and 2.0 ms | no |
| (2026-11-28, C5) The legend written only where it changed, on a draw | `ab.cjs`, two sessions; `tools/zoom.cjs` | paired −16 and −5 ms (last byte); zoom: layout 14.6 to 12.7 ms | yes |

The two steps of 2026-11-28 were measured together, with the earlier patches, as one "after": the
lock that every browser run waits for (shared with three other builders, 10 to 30 minutes a turn)
left room for one complete alternating comparison per layout, not one per step. So their separate
shares are not measured; the profile after shows where the time now goes.

Not tried: a two-step or canvas rendering (it changes what a person sees: out of scope); decimating
points (721 points on a plot about 1,300 px wide); deferring the legend rows or the text form.

## Mutants

On copies in the scratch area, never in the tree. Every one was caught, except one of the legend's (below), reported as it is.

| Mutant | Caught by |
|---|---|
| (2026-11-27) Band: lowest taken as `p > lo` | `model-equivalence.test.mjs`, first test |
| (2026-11-27) A series' figures read to `length - 1` | `model-equivalence.test.mjs`, first test |
| (2026-11-27) Band: the first member of Other left out | `model-equivalence.test.mjs`, first test |
| Chart: a NaN in a typed series kept as a value | `model-equivalence.test.mjs`, second test |
| Chart: a typed gap written as 0, not null | `model-equivalence.test.mjs`, second test |
| Chart: a typed window one step short | `model-equivalence.test.mjs`, second test |
| Series: the parser's placement used without checking it is the query's grid | `app/src/api/matrixGrid.test.ts` |
| Series: ±Inf kept on the grid | `app/src/api/matrixGrid.test.ts` |
| Parser: a series placed with its last sample left out | `app/src/api/matrixGrid.test.ts` |
| Spec: the typed form not scaled | `app/src/charts/typedSpec.test.ts` |
| Spec: the typed form copying when not scaled | `app/src/charts/typedSpec.test.ts` |
| (C5) Legend: a changed figure cell not written | `legend-writes.test.cjs` (900 px, seed 1, step 4) |
| (C5) Legend: focus in the legend not looked at | `legend-writes.test.cjs` (step 11, focus on a row then new figures) |
| (C5) Legend: the note not written again | `legend-writes.test.cjs` (step 8, other series) |
| (C5) Legend: a row whose first cell changed not written | `legend-writes.test.cjs` (step 8, other series) |
| (C5) Legend: the column widths not written again | `legend-writes.test.cjs` (step 4, the same result after a zoom) |
| (C5) Legend: a sort or Show more keeping what is written | `legend-writes.test.cjs` |
| (C5) Legend: the head not written again | `legend-writes.test.cjs` (step 9, the other width). It **survived** the test's first version, which never changed the width: at one width the head's markup is its words, which `legendState()` and `cursor()` write anyway; the step "the other width" was added for it |

The 2026-11-27 mutant "x positions written to whole pixels" was not run again: path text is covered
by the markup hashes of `identity.cjs`, which compare it character for character.

## Waiver request: the result's first paint at 200 series

For a second reviewer (decided in `second-review.md`: waived with conditions; see the top of this
file). The rows: "Receives a result: paint it … 100 ms after it arrives", at 200 series, both layouts,
both definitions. **Not everything else in B1 was met in this session:** the phone's 36-series chart to
table read 101 ms at the 75th percentile (6 of 20 runs over 100), a Speed failure by the rubric's
measure, not caused by this change (113 ms before), and not covered by this request. Chart to table at
200 on the phone was inside (91 ms), near its limit. (In the second session, "C2", the first read 86 ms
and the second 127 ms.)

**The best measured numbers** (this session, 20 alternating runs, every run judged, load 1.2 to 2.8):

| 200 series | Body read to painted: median / p75 | Last byte to painted: median / p75 |
|---|---|---|
| Desktop, before | 164 / 190 | 192 / 218 |
| Desktop, after | 110 / 127 | 136 / 156 |
| Phone, before | 98 / 106 | 114 / 125 |
| Phone, after | 79 / 101 | 95 / 118 |

Of the last byte row, about 10 to 20 ms at 200 series is the harness's own copy of the body (10 runs,
"The measuring method"), which a person's browser does not make either; it is in both builds, so the
comparison stands, and the absolute figure overstates by about that much.

**The remaining breakdown** at 200 series on the desktop ("The profile after", shares of 161 ms under
the profiler): the chart's plot markup and the browser's native work in drawing it about 45 per cent,
the model about 14, the browser's layout about 16, the legend about 6, parse, paint and style about 12,
collection 5, the app 3. The work that is proportional to the number of values (the model's pass over
144,000 values, and writing them as path text for the drawn lines and the band) is about a third; the
rest is drawing an SVG of this size and laying out the legend, the same at 36 series.

**What a person sees.** When a query returns 200 series, the chart appears about an eighth of a
second after the answer has arrived on a desktop window with a mid-range phone's CPU (median 0.11 s, 3
in 4 within 0.13 s, from the last byte 0.14 and 0.16 s), and about a tenth of a second on the phone
layout (0.08 and 0.10 s; 0.10 and 0.12 s). Before this change it was a sixth to a fifth of a second on
the desktop. Nothing moves meanwhile (layout shift from the press to the settled result: 0 in all 80 runs at
200 series), the previous result stays visible under the waiting line, and the press is answered at
once. The whole wait, from releasing Run query to the result painted, is 1.72 s on the desktop and
1.04 s on the phone at the median ("after"; 1.76 and 1.06 before), most of it the 3.4 MB answer on Fast
4G, so the paint after the last byte is the last 8 or 9 per cent of the wait.

**How often.** Not measured: viz is not deployed (`app/README.md`), so there is no record of what
people query. What can be said: in Explore a result has 200 series only when a query groups by a
label with that many values (per pod, per route and status across a fleet) or returns raw series
unaggregated; the chart colours 8 and folds the rest into Other, so such a result is legible but not
the common way to ask. In dashboards the panels are written by people for reading, and a 200-series
panel is unusual; the dashboards view also still uses the chart's first form (and so did not gain
the typed path), and its speed is not in this comparison. The 36-series case, which is common in
Explore (`sum by (service, route, status)`), now meets the budget on both layouts.

**What would meet it, and what it would change for a person.**

1. *Draw on a canvas, or in a worker* (`OffscreenCanvas`): the plot's markup (path text, `innerHTML`,
   the browser's parse, style and layout of it) would go. It changes the picture's pixels and the way
   the plot is read by assistive technology (the SVG's structure), so it is a design change of the
   system's chart, not tuning. Out of scope by the lead's decision.
2. *A two-step paint*: the coloured lines first, the band and the legend in the next frame. A person
   would see a frame without the band. Out of scope by the lead's decision.
3. *The legend table's layout* (about 8 of the browser's 13 to 15 ms of layout at every size, found on
   2026-11-27): no cause was found and two CSS changes did nothing. Finding it would change nothing a
   person sees, and might give 5 to 10 ms; not enough alone.
4. *Draw from a partial result as it arrives*, refining in place ("coarse data first, refined in
   place", as the budget's own row allows): the chart would show part of the series, or a coarse grid,
   before the last byte. A person would see the chart fill in. It is allowed by the README's wording,
   but it is a change of what is seen, so it is the system owner's call.
5. *The harness's copy of the body*: taking "body read" and "last byte" in separate runs (with and
   without the copy) removes 10 to 20 ms from the last-byte row at 200 series. It changes no pixel and
   only the measurement; it is not enough alone for the desktop.

My estimate: (3) and (5) together might bring the phone inside at the 75th percentile, not the desktop;
the desktop needs (1), (2) or (4).

## Checks run

All under the shared lock, credentials removed from the environment.

| Check | Where | Result |
|---|---|---|
| `node design-system/tools/build.mjs` | the shared tree, with the chart change | wrote `dist/` |
| `node design-system/tools/check.mjs design-system/project/components/Chart` | the shared tree | exit 0: rendered audit 0 failures (30 previews, both themes, rest, hover, press, a finger's press, reserved heights), contrast and structure 873 of 873, literal values 0 |
| `cd design-system && npm test` | the shared tree | 199 tests: 139 pass, 0 fail, 60 skipped (the slow set, `test:slow`, not run) |
| `model-equivalence.test.mjs` | the scratch copies (before, after) | 2 of 2 pass |
| `npx tsc --noEmit`, `npx vitest run` | the scratch "after" | tsc clean; 23 files, 233 tests pass (before the last edit, a type annotation in `typedSpec.test.ts`, after which `npm run build`, which runs `tsc --noEmit`, was clean) |
| the same, on the shared tree's `app/` as it is now with `app.patch` applied, in a copy | `tsc` clean; 23 files, 233 tests pass (10:32 UTC) |
| `git apply --check design-system/reviews/chart-speed/app.patch` | the shared tree | passes |
| mutants | copies in the scratch area | 8 of 8 new ones caught (above) |
| the app's e2e suites | | **not run** on the patched app at the time (see the next table) |

**On the merged tree** (2026-11-28 afternoon: this change and the monitors view on top of the app's
fixes for the second review, commit `67d9d73`; the app's source has not changed since), every
command under the shared lock with the Cloudflare credentials removed from its environment:

| Check | Result |
|---|---|
| `npm test` | 26 files, 252 tests pass |
| `npx tsc --noEmit` | clean |
| `npm run check:tokens` | 759 of 759; 0 literal values in 81 files |
| `npm run build` | passes (`dist/` 11:05 UTC, the build every browser run below used) |
| `node e2e/app.cjs` | 156 of 156 |
| `node e2e/errors.cjs` | 14 of 14 (the error paths go through the new parser) |
| `node e2e/prod.cjs` | 23 of 23 |
| `node e2e/dashboards.cjs` | 106 of 106 |
| `node e2e/monitors.cjs` | 69 of 69 |
| `node e2e/real.cjs` (the real API under `wrangler dev --local`; nothing deployed, no account used) | 25 of 25 |
| `node e2e/contract.cjs` (the same requests to the real API and the mock) | 116 of 116; two error messages differ in wording, which the app does not read (reported, not failures). It rewrote `e2e/measurements/contract-real.json` |

No suite needed a change, and no expectation was changed.

**After the third review's round** (2026-11-28, 14:24 to 14:33 UTC, under the shared lock, credentials removed): on a copy
of HEAD (`4dea3c5`) with the legend change, in the scratch area with `node_modules` linked (the shared tree had other
builders' edits in progress in `app/`), its `preview.html` the same file as the tree's:

| Check | Result |
|---|---|
| `node tools/build.mjs` (design system) | wrote `dist/` |
| `node tools/check.mjs project/components/Chart` | exit 0: rendered audit 0 failures (30 previews, both themes, rest, hover, press, a finger's press, reserved heights), contrast and structure 873 of 873, literal values 0 |
| `cd design-system && npm test` | 199 tests: 139 pass, 0 fail, 60 skipped (the slow set) |
| `npx vitest run --no-cache --maxWorkers=2` (app) | 26 files, 252 tests pass (the first run failed to load `mock/monitors.test.ts`: the copy lacked `../ruler/openapi.json`; with it copied from HEAD, all pass) |
| `npx tsc --noEmit` | clean |
| `npm run check:tokens` | 759 of 759; 0 literal values in 81 files |
| `npm run build` | passes |
| `node e2e/app.cjs`, `errors.cjs`, `prod.cjs`, `dashboards.cjs`, `monitors.cjs` | 156 of 156, 14 of 14, 23 of 23, 106 of 106, 69 of 69 |
| `legend-writes.test.cjs` | 2,480 steps equal; 7 mutants caught (one only after the width step was added) |
| `tools/identity.cjs --full-raster --rounds 2` | 146 states identical (twice: first and final version of the change) |

## Open items

- **The waiver**: decided (`second-review.md`, `third-review.md`), not in effect. C5: the desktop's 36-series
  rows are met by SR with the legend change (99.7 ms in the second session: no margin), but its paired gain is not
  beyond the noise by C1's rule; the phone's chart to table is **not met** at 36 and 200 series (pooled 101.1 and
  103.1 ms over three sessions) and needs a fix in the table's markup or CSS, or a waiver of its own. C4 waits for a
  reviewer. F1 to F4 stand; the waiver lapses on 2026-12-31 without F1.
- The waiting line's `shownAt` is stamped in a passive effect, so its 300 ms can start late (C4, item 3 in
  `waiting-line/README.md`); a layout effect would not. For the app's reviewer.
- `design-system/tools/speed.mjs` enables the Network domain with its buffers on (line 118): its figures
  for large bodies may carry the same DevTools cost. The system's owner should apply the same change
  there (or say why not).
- The harness's own copy of the body costs 10 to 20 ms after the last byte at 200 series (10 runs):
  take the two rows from separate runs, or accept it and say so.
- `app.patch` changes one frame a person sees (the waiting line goes one frame sooner): the frame records
  are in `waiting-line/`; the app's reviewer judges them (C4).
- The dashboards view still uses the chart's first form; moving it to the typed form is one argument
  (`typed: true` in `dashboards/PanelView.tsx`) and needs its own before and after.
- The design-system images (`shots.mjs`) were not made again: identity shows there is nothing to show.

## Files here

| File | What it is |
|---|---|
| `app.patch` | every `app/` change, against the shared tree's `app/` as it is now (`git apply --check` passes) |
| `model-equivalence.test.mjs` | the chart's model and text form before and after (needs `VIZ_BEFORE`), and the typed form against the first (needs nothing) |
| `tools/ab.cjs` | alternating before/after; `--buffer`, `--noclone`, and builds named `x+buffer` or `x+noclone` to compare methods on one build |
| `tools/identity.cjs` | identity of rendering between builds; `--rounds`, `--full-raster`, `--series`, `--widths` |
| `tools/harness-edit.cjs` | the harness change, as applied to `ab.cjs` and `app/e2e/measure.cjs` |
| `tools/profile.cjs`, `tools/micro.cjs`, `tools/summarise.cjs`, `tools/pixdiff.py` | the profile, the micro-benchmarks, the tables, where two images differ |
| `tools/waiting-frames.cjs` | the frame record of the end of a wait, and the waiting line's 300 ms minimum (C4; `waiting-line/README.md`) |
| `waiting-line/` | C4's frame records, before and after, both layouts, with a note (`README.md`); since the third review the exact-frame images (`images/`, `shots-*.json`), the dashboards' records and 20 phone runs at 36 series |
| `legend-writes.test.cjs` | (C5) the legend written part by part against written afresh: markup and focus after every step of random sequences (needs `VIZ_BEFORE`, `VIZ_AFTER`: two `design-system/` dirs with `dist/`) |
| `tools/lay.cjs`, `tools/lay-variants-*.json` | (C5) where the layout after a draw goes, by part, with CSS variants |
| `tools/zoom.cjs` | (C5) a new range of the same series, timed in the page, two builds alternated |
| `tools/frame-shots.cjs`, `tools/compose.py` | (C4) images of exact frames, by begin-frame control, and the before/after sheets |
| `tools/pool.py`, `tools/pair.py` | a row's 75th percentile per session and pooled (SR); paired medians split by order |
| `tools/legend-mutants.sh` | the legend's mutants, as run (scratch paths) |
| `data/c5-*.json`, `data/c5-*.txt`, `data/identity-c5*` | the third review's sessions, the layout attribution, the zoom timing, identity |
| `data/c1-desktop.json`, `data/c2-desktop.json`, `data/c2-phone.json`, `data/merge-desktop.json` | the afternoon's runs: C1, C2, and the merged tree against the change alone |
| `data/` | every run with its load (`ab-desktop.json`, `ab-phone.json`, `method.json`, `clone.json`), the identity results; `2026-11-27/` holds the paused session's files (its tables and profiles), measured with the buffers |

`chart.patch` and `harness-nobuffer.patch` of 2026-11-27 are gone: the first is now in the chart's
source, the second in `app.patch`. `app-option-one-pass.prototype.patch` is gone: option 1 was done in
the parser instead.

## How to run it again

Two copies side by side, each with `app/`, `design-system/` and `dashboard/` and `node_modules` linked:
`before` at the commit before, `after` with the patches; `npm run build` in each `design-system/` and
then each `app/`. Ports 8971 (mock) and 8980 upward; nothing touches Cloudflare.

```
VIZ_APP_LIB=<before>/app/e2e/lib.cjs node tools/ab.cjs --builds before=<before>/app,after=<after>/app --series 4,12,36,200 --runs 20 --skip typing,crosshair,local [--phone] --out ab.json
node tools/ab.cjs --builds buffer+buffer=<before>/app,nobuffer=<before>/app --series 4,200 --runs 20 --skip typing,crosshair,local --out method.json
node tools/identity.cjs --builds before=<before>,after=<after> --rounds 2 [--full-raster] --out identity.json --images diff/
VIZ_BEFORE=<before>/design-system/project/components/Chart/preview.html VIZ_AFTER=<after>/design-system/project/components/Chart/preview.html node --test model-equivalence.test.mjs
node tools/profile.cjs --lib <before>/app/e2e/lib.cjs --root <after unminified app> --series 36,200 --runs 5 --nobuffer [--phone] [--table]
node tools/summarise.cjs ab.json
VIZ_APP_LIB=<before>/app/e2e/lib.cjs node tools/waiting-frames.cjs --builds before=<before>/app,after=<after>/app --runs 3 --min-runs 5 [--phone] --out waiting-line/frames-desktop.json
# the third review (C5, C4)
node tools/identity.cjs --builds final=<final>,new=<new> --rounds 2 --full-raster --out data/identity-c5b.json
VIZ_BEFORE=<final>/design-system VIZ_AFTER=<new>/design-system node --test legend-writes.test.cjs
VIZ_E2E_APP_PORT=… VIZ_E2E_MOCK_PORT=… node tools/lay.cjs --lib <before>/app/e2e/lib.cjs --root <final>/app --series 36 --n 11 --variants tools/lay-variants-1.json
node tools/zoom.cjs --lib <before>/app/e2e/lib.cjs --builds final=<final>/app,new=<new>/app --series 36 --n 25 --rounds 4
VIZ_APP_LIB=<c4a154b>/app/e2e/lib.cjs node tools/ab.cjs --builds final=<final>/app,new=<new>/app --series 36 --runs 20 --skip typing,crosshair,local --out data/c5-desktop-s2.json
python3 -I tools/pool.py responseFull 36 data/c5-desktop-s1.json:new data/c5-desktop-s2.json:new
node tools/frame-shots.cjs --builds before=<c4a154b>/app,after=<final>/app [--phone] --theme light --series 200,36 [--dashboard] --out waiting-line/shots-….json --images <dir>
python3 -I tools/compose.py waiting-line/images waiting-line/shots-*.json   (reads the frames from <dir> next to the json as images/)
node tools/waiting-frames.cjs --builds before=…,after=… --dashboard [--phone] --runs 3 --min-runs 0 --out waiting-line/frames-dashboard-desktop.json
```

The afternoon's runs (C1, C2, the merge check, C4) used the same commands, with `before`, `cc50ea2`,
`a3ba07d` and the merged tree as the builds, ports 8971 to 8995, and `c4a154b`'s `app/e2e/lib.cjs` (so
its mock) for every one.
