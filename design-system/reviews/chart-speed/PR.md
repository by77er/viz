# Chart speed: a many-series result painted sooner (app-v9 review, B1)

## Paused 2026-11-27

Work stopped on the owner's instruction before it was finished. **Nothing in the shared tree was
changed** except this directory: the chart's source, `dist/` and `app/` are as they were (checked:
`design-system/project/components/Chart/preview.html` is byte-identical to commit `0aa0f7a`). Nothing
was committed. Everything below was **measured here** (this shared 4-core machine, Chromium headless
shell under Playwright, CPU slowed 4x, Fast 4G, the development mock on localhost); the load is given
with every figure. The scratch copy it was built in is gone; the patches and tools here rebuild it.

**Where it stands, in five lines.**

1. The change in hand (`chart.patch` and `app.patch`) makes the result's paint a little quicker and
   **does not bring 200 series on the desktop inside the budget**: 20 alternating runs, body read to
   painted, 75th percentile 135 ms before and 118 ms after, against 100.
2. Its measured gain is small and partly inside the noise: the median of paired differences is
   -9 ms at 36 series on the desktop (quicker in 16 of 20 pairs), -12 ms at 200 (9 of 16), -4 ms at
   36 and at 200 on the phone (13 and 11 of 20). The profile had promised three times that.
3. **Identity is not proven.** One run of the comparison found the chart's markup, accessible names,
   legend row names, text form and table the same before and after in every one of 102 states, and
   screenshots that differ in 12 states (by 1 to 11 pixels, or by a 4 px shift of words in the head that
   follows the clock), as two runs of the *same* build also do (11 states). The tool was changed to
   settle that and was not run again.
4. "From the last byte" cannot be met at 200 series as the harness measures it: about 70 ms of that
   row is DevTools keeping its own copy of the body (below). That is the largest single finding.
5. What would meet the budget at 200 series is not in these patches: fewer passes over the 144,000
   values (options at the end). One of them is prototyped, tested for equivalence, and unmeasured.

**Files here.**

| File | What it is | State |
|---|---|---|
| `chart.patch` | `design-system/project/components/Chart/preview.html`: the model's two loops, path text, the width cache. Applies to the tree with `git apply` | **unproven work in progress**: identity not established; `tools/check.mjs` and `npm test` of the design system not run on it (`tools/test/chart-rules.test.mjs` alone: 21 of 21) |
| `app.patch` | `app/src/explore/waiting.tsx`: the waiting line goes in the render that shows the result | **unproven work in progress**: `tsc` clean, 224 unit tests pass, `e2e/app.cjs` 128 of 130 with the same two keyboard-order checks failing before and after; `errors.cjs`, `dashboards.cjs`, `prod.cjs` not run; changes one frame a person can see, so it needs the app's reviewer |
| `app-option-one-pass.prototype.patch` | Option 1 below: `specOfMatrix` in `app/src/charts/spec.ts`, used by Explore | **unproven prototype, never measured**; made against `0aa0f7a`, and `ExplorePage.tsx` has changed since, so its third file needs applying by hand |
| `harness-nobuffer.patch` | `--nobuffer` for `app/e2e/measure.cjs` | proposal, not applied; reaches into Playwright's own session |
| `model-equivalence.test.mjs` | `chartModel` and `textLines` before and after over 600 random results | passes; three mutants caught (below) |
| `tools/` | `profile.cjs`, `ab.cjs` (alternating before/after), `identity.cjs`, `summarise.cjs`, `micro.cjs` | as used; `identity.cjs` holds changes made after its one run (repeated captures, the age not displayed, the fixture's time stamp left out) that have never been run |
| `data/` | `ab-desktop.json`, `ab-phone.json` (the tables below, every run with its load), `ab-try*.json` (the earlier 4- and 6-run trials), `prof-*.txt` (profiles), `identity.txt`, `identity-first-run.json` | |

## What changed in the patches

**`chart.patch`** (the one source of `dist/viz-chart.js`):

1. `chartModel`: each series' last, lowest and highest value are read in an indexed loop, not
   `for … of`; the Other band is gathered series by series into two `Float64Array`s, not step by
   step across 192 arrays.
2. Path data: every series of a draw shares its x positions, so each is written as text once per
   draw and not once per series; the band's edges reuse the y text its area was written with. The
   text of every `d` is meant to be the same, character for character.
3. Text widths are cached in one map per font, so a look-up builds no key string.

No token, class, markup or CSS. **`app.patch`**: `useWaiting` hides the waiting line in the render
that shows the result when it has been up for its 300 ms; before, an effect hid it one render later,
so every wait over 400 ms (always, at 200 series on Fast 4G) rendered the page twice and left the
line over the new result for one more frame (seen in `tools/profile.cjs --frames`: three changes to
the panel in two frames before, two changes in one frame after).

## The profile before (where the time went)

`tools/profile.cjs`: a Chrome trace (`devtools.timeline`) and a sampling CPU profile (250 µs)
around the press on Run query, cut to the window; median of 5 runs; an unminified build of the
same source so that functions have names (it runs about a tenth slower than the measured build,
and the profiler adds to that: read the shares, not the totals). Full output: `data/prof-before-*.txt`.

| From "a copy of the body has been read" to "painted", ms at 4x CPU | Desktop 36 | Desktop 200 | Phone 36 | Phone 200 |
|---|---|---|---|---|
| **Total** (load at run start 2.3 to 4.5) | 90 | 165 | 77 | 115 |
| App, React render of the page | 10 | 31 | 10 | 24 |
| of which: result on the time grid (`alignSeries`) | 7 | 14 | 2 | 9 |
| of which: grid to the chart's arrays (`toSpec`) | < 1 | 14 | 3 | 9 |
| Chart, `draw()` | 42 | 60 | 26 | 39 |
| of which: the model (`chartModel`: figures of every series, slots, the band) | 10 | 26 | 6 | 15 |
| of which: the plot's markup (`drawPlot`: path text, then `innerHTML`) | 20 | 22 | 11 | 10 |
| of which: the legend (`legend`) | 6 | 10 | 6 | 7 |
| of which: the text form | 2 | 2 | 1 | 1 |
| Garbage collection (young generation) | 6 | 17 | 4 | 8 |
| Browser: layout | 13 | 15 | 15 | 11 |
| Browser: parse of the chart's markup | 4 | 5 | 2 | 3 |
| Browser: style, pre-paint, paint | 6 | 9 | 6 | 6 |
| A second render and frame to take the waiting line away (from one trace: a 13 ms task, then a frame of 7 to 10 ms; the phone's was seen, not timed) | 0 | about 15 to 20 | 0 | present |

What the profile says, against the candidates in the brief:

- **JSON parse** is not in this window: the app reads the body as it arrives into typed arrays
  (`api/matrix.ts`), and its last piece is done before the harness's copy resolves.
- **DOM nodes for the uncoloured series**: there are none to save. Other is already one band (three
  paths) however many series it holds; a 200-series plot's markup is 131 parser tokens.
- **Reads after writes**: one (`svg.clientWidth` at the start of a draw, 1 to 3 ms, because React
  has just written the head). Left alone: the same layout is due at the frame anyway.
- **Legend rows beyond the visible ones, table preparation**: already not on this path (the legend
  holds 8 rows and Other; the table is prepared in idle time).
- **Decimation to the pixel grid**: 721 points on a plot about 1,300 px wide on the desktop, so there
  is nothing to drop there; not done on the phone either (identity would have to be shown per width).
- What it does show: three passes over all 144,000 values in interpreted or half-optimised code
  (the page has run each loop once before, at load), 17,000 `toFixed` calls for 8,600 points, a
  young-generation collection of arrays that all survive, and a whole extra render for the waiting line.
- **Layout (13 to 15 ms) is the legend table**, not the SVG: with the legend table not displayed the
  same draw lays out in 5 ms; with the plot's text not displayed 12 ms; with its paths not displayed
  15 ms. It is the same at 4 and at 200 series. Not changed here (see "What did not help").

**The harness's own cost, found on the way.** From the last byte to "a copy of the body has been
read" is 23 to 33 ms at 36 series and 58 to 100 ms at 200. Most of that is neither the app nor the
chart: with the DevTools Network domain enabled (Playwright enables it for every page, and
`measure.cjs` and `speed.mjs` enable it again in their own session), each agent keeps a copy of the
body and decodes it on the page's main thread when the load finishes
(`ResponseBodyLoader::DidFinishLoadingBody`, two `TextResourceDecoder::Decode` of 3,436,881 bytes:
72 ms in one task at 4x CPU, before the page's next task can run). With both buffers set to zero
(`Network.enable {maxTotalBufferSize: 0, maxResourceBufferSize: 0}` on both sessions) the same
build's last byte to body read fell from about 100 ms to 25 to 32 ms. No browser without DevTools
open does this work. So the row "from the last byte" carries about 70 ms at 200 series that a person never waits for
(at 36 series it was not measured; by the size of the body it would be about 12 ms). `harness-nobuffer.patch` adds this as an option to
`app/e2e/measure.cjs` (not applied; it reaches into Playwright's own session, which is not a public
interface, so the default should stay and a figure taken with it should say so). The tables below give the row as the harness defines it. The 20-run comparison without the buffers was
queued and not run before the pause; what exists is three runs each way of the build before the change
(last byte to body read 129, 101 and 264 ms with the buffers; 29, 25 and 256 ms, then 32, 260 and 261 ms
without: the runs near 260 ms are the ones in which the harness's own copy resolved after the paint).

A second thing about the harness: its "body read" figure is only taken when its own copy of the body
resolves before the result's first change to the page. When the app is ahead of that copy the run
has no such figure (it still has "from the last byte"). The number of runs behind each cell is in
the tables for that reason.

## Before and after

`tools/ab.cjs`: `app/e2e/measure.cjs` with the two builds taken in turn, run by run (before, after;
after, before; …), 20 runs each, typing, crosshair and the forms other than the table left out. A
cell is median / 75th percentile (lowest to highest; runs that have the figure). Budget: 100 ms.
"Before" is commit `0aa0f7a`; "after" is both patches.

**desktop**: Chromium, CPU 4x, Fast 4G, 1440x900, fine pointer, fresh context per run; builds alternated run by run. Started 2026-11-27 02:13 UTC, calibration 332 ms, 4 cores. `ab-desktop.json`

| Series | Build | Load at run start: median (range); runs at or below 4 | Body read to painted, ms | Last byte to painted, ms | Chart to table, ms |
|---|---|---|---|---|---|
| 36 | before | 2.7 (1.6 to 3.3); 20 of 20 | 79 / 89 (48 to 131; 20) | 103 / 111 (89 to 157; 20) | 57 / 61 (41 to 85; 20) |
| 36 | after | 2.5 (1.7 to 3.2); 20 of 20 | 74 / 76 (39 to 122; 20) | 97 / 105 (62 to 157; 20) | 56 / 62 (43 to 94; 20) |
| 36 | pairs: after less before | | -9; quicker in 16 of 20 | -8; quicker in 15 of 20 | -2; quicker in 10 of 20 |
| 200 | before | 3.8 (2.3 to 4.4); 13 of 20 | 122 / 135 (91 to 179; 18) | 206 / 223 (173 to 265; 20) | 66 / 72 (57 to 95; 20) |
| 200 | after | 3.5 (2.2 to 4.5); 13 of 20 | 114 / 118 (88 to 187; 18) | 204 / 216 (168 to 296; 20) | 63 / 72 (45 to 147; 20) |
| 200 | pairs: after less before | | -12; quicker in 9 of 16 | -5; quicker in 11 of 20 | -4; quicker in 12 of 20 |

**phone**: Chromium, CPU 4x, Fast 4G, 400x800, coarse pointer, touch, device scale 2, fresh context per run; builds alternated run by run. Started 2026-11-27 02:21 UTC, calibration 352 ms, 4 cores. `ab-phone.json`

| Series | Build | Load at run start: median (range); runs at or below 4 | Body read to painted, ms | Last byte to painted, ms | Chart to table, ms |
|---|---|---|---|---|---|
| 36 | before | 2.1 (1.7 to 2.7); 20 of 20 | 58 / 66 (47 to 75; 20) | 70 / 79 (58 to 96; 20) | 81 / 84 (65 to 121; 20) |
| 36 | after | 2.1 (1.6 to 2.6); 20 of 20 | 58 / 63 (42 to 76; 20) | 72 / 76 (52 to 87; 20) | 78 / 83 (60 to 106; 20) |
| 36 | pairs: after less before | | -4; quicker in 13 of 20 | -3; quicker in 11 of 20 | -4; quicker in 12 of 20 |
| 200 | before | 3.3 (2.2 to 5.2); 14 of 20 | 91 / 93 (82 to 117; 20) | 142 / 148 (127 to 176; 20) | 91 / 96 (77 to 144; 20) |
| 200 | after | 3.4 (2.3 to 5.8); 13 of 20 | 87 / 98 (73 to 118; 20) | 135 / 154 (111 to 179; 20) | 91 / 98 (71 to 131; 20) |
| 200 | pairs: after less before | | -4; quicker in 11 of 20 | -8; quicker in 12 of 20 | -1; quicker in 10 of 20 |

**Not measured:** 4 and 12 series (queued, stopped by the pause, so "no regression on a small result"
is not shown); the comparison without DevTools' buffers; a second session. The review asked that a
row within a tenth of its limit be measured twice: none of these was.

**Which rows meet the budget in this session** (75th percentile, as the harness defines the rows):

| Row | Desktop 36 | Desktop 200 | Phone 36 | Phone 200 |
|---|---|---|---|---|
| Body read to painted, before | 89, inside | **135, over** | 66, inside | 93, inside |
| Body read to painted, after | 76, inside | **118, over** | 63, inside | 98, inside by 2 |
| Last byte to painted, before | **111, over** | **223, over** | 79, inside | **148, over** |
| Last byte to painted, after | **105, over** | **216, over** | 76, inside | **154, over** |
| Chart to table, before | 61 | 72 | 84 | 96, inside by 4 |
| Chart to table, after | 62 | 72 | 83 | 98, inside by 2 |

The build before the change read lower here than in the review (109, 143 and 119 ms there for desktop
36, desktop 200 and phone 200; 89, 135 and 93 here): the machine, not the code. So the phone's
200-series rows and the desktop's 36-series row "inside" above are this session's reading of a row the
review found over, and are not a pass. At 200 series on the desktop 7 of the 20 runs of each build
began at a load above 4 and by the README's rule are not judged; the 9 runs of each at a load of 3.5
or less read 126 / 140 before and 112 / 116 after.

**Why the gain is smaller than the profile's sum.** The profile was taken with the sampling profiler
on an unminified build, which keeps the loops in the slower tiers; in the measured build the optimiser
has most of them compiled by the second result (`tools/micro.cjs`: the figures loop is 10.6 ms as
`for … of` and 3.8 ms indexed on its second run in a page, and about 5 ms either way from the third).
The earlier short trials (`ab-try*.json`, 4 and 6 runs) read -22 and -16 ms at 200 series; the 20-run
tables are the ones to believe.

## Chart to table at 200 series on the phone

Not the same cause, and not fixed. Profile of the build before, median of 5 (92 ms; load 3.6 to 4.2):
script 21 ms (React rendering the table's 50 rows, 11 ms), layout 27 ms, style 14 ms, paint and
pre-paint 9 ms, layerise, hit test and commit 7 ms, the rest tasks with nothing named in them. It is
the browser styling and laying out the table and the page around it as the chart is parked; the
chart's script is not in it. This session read 96 and 98 ms at the 75th percentile (the review: 114
to 122). A fix would be in the table's markup or CSS, or in showing fewer rows first, which a person
would see.

## Identity: what was checked and what was not

`tools/identity.cjs`, one run, three builds (before, after, and a second copy of before as a
control), 102 states per build: Explore at 4, 36 and 200 series, light and dark, 1440 px and 400 px
(touch, device scale 2), at rest, with a keyboard readout, with a pointer readout (1440 only), zoomed
in, with Other opened, with a legend row chosen, as table and as text; and the design system's own
Chart preview and fixture pages in the same themes and widths, at rest and with a keyboard readout on
every chart. Per state: SHA-256 of a full-page screenshot and of every chart's markup, the charts'
accessible names, the legend rows' names, the text forms, the table. Output: `data/identity.txt`,
`data/identity-first-run.json`.

- **Chart markup, accessible names, legend row names, text form, table: the same before and after in
  every Explore state and on the Chart preview page.** On the fixture page the markup hash differs in
  all 8 states, between the two copies of *before* as well: the page stamps each chart with the time
  its data was fetched (`data-for`); its screenshots are the same in 7 of 8 states (one pixel in the eighth).
- **Screenshots: 12 states differ between before and after (one of them on the fixture), and 11 between before and its own copy.**
  Three kinds, read from the images: (a) in the text form at 1440 px, the head's range and step sit 4 px
  to one side (about 1,500 pixels): the age of the result, which the tool hid but left in the layout, is
  "just now" or "5 s ago" by the clock; (b) 1 to 11 single pixels at the crosshair's dots and at the
  plot's left and right edges at 1440 px, 1 to 6 of them between two runs of the same build; (c) 4
  pixels at the left edge of the Chart preview at 1440 px light, and 1 on the fixture at 400 px light,
  between before and after only, of the same kind as (b).
- So no difference was found that the change explains, and **pixel identity is not shown**. The tool now
  removes the age from the layout, leaves the fixture's stamp out of the hash, and captures every build
  several times, calling a state identical when any capture of one build equals any capture of the other
  bit for bit (`--rounds`). That version has not been run. If (c) survives it, it has to be explained
  before the chart patch is applied.
- `model-equivalence.test.mjs`: the model, the colour map and the text form are the same before and
  after over 600 random results. It does not cover path text, which only the markup comparison does.

## What did not help, and what was not tried

Tuning steps in order, each measured here; the ones that did nothing are kept.

| Step | How it was measured | Result | Kept |
|---|---|---|---|
| Indexed loop for a series' figures, in place of `for … of` | `tools/micro.cjs`: 200 x 721 values in a page at 4x CPU, the loop's second run in the page (what the harness's run is) | 10.6 ms to 3.8 ms (later runs: about 5 either way) | yes |
| The band series by series into typed arrays, in place of step by step | same | 10.6 ms to 0.9 ms | yes |
| x text once per draw | same, 8,652 points | 9.4 ms to 6.7 ms on the second run, 9.5 to 1.0 once optimised | yes |
| Text-width cache without a concatenated key | not measured alone (under 1 ms in the profile) | no measurable change by itself | yes: it only removes work |
| Waiting line hidden in the result's render (app) | frames after the result in `tools/profile.cjs --frames` | 3 changes in 2 frames became 2 changes in 1 frame at 200 series | yes (app patch) |
| `Array.from(typed)`, spread, or `slice.call` for the grid-to-array copy in `toSpec` | `tools/micro.cjs` | 16 to 33 ms against 5 ms for the loop the app has | no: slower |
| `v - v === 0` in place of `Number.isFinite` there | same | 4.7 against 5.4 ms on the second run: inside the noise | no |
| `vector-effect: none` on the plot's shapes (the plot is never scaled) | `tools/profile.cjs --css`, layout time of the result's frame, 36 series | 13.8 ms to 13.6 ms | no: no effect |
| `table-layout: fixed` on the legend table | same | 15.1 ms to 13.8 ms, inside the noise of 3 runs | no: not shown to help, and it would need its own identity proof |
| `content-visibility: visible` on the chart | same | 14.1 ms | no: no effect |

Not tried, because the profile did not point at them: one path element for Other's lines (Other is
already one band), deferring legend rows or the text form (2 ms together, and the app's fixes and
tests read them in the same task), decimating points. Not done, because it would change what a
person sees: painting the coloured series first and the rest a frame later.


## Mutants

On copies in the scratch area, never in the tree.

| Mutant | Caught by |
|---|---|
| Band: lowest taken as `p > lo` | `model-equivalence.test.mjs`, case 0 |
| A series' figures read to `length - 1` | `model-equivalence.test.mjs`, case 0 |
| Band: the first member of Other left out | `model-equivalence.test.mjs`, case 0 |
| x positions written to whole pixels (`toFixed(0)`) | **not run**: prepared for `identity.cjs --only system`, stopped by the pause |

## What I believe the fix is, and how far it is

Remaining at 200 series on the desktop, from the profile of the patched build (148 ms under the
profiler at a load of 4.5 to 4.8, so shares only): the app's two passes over the result 29 ms
(`alignSeries` 20, `toSpec` 9), the chart's draw about 55 ms (model 16, plot markup 16, legend 10),
layout 14 ms (the legend table), garbage collection 6 ms, React about 12 ms. Three options, largest first:

1. **Do the per-value work once, and before the last byte.** The parser already fills typed arrays as
   the body arrives; putting each finished series on the time grid there (the window is known when the
   request is sent) takes `alignSeries` off the path by both definitions. It needs `app/src/api/` and
   `app/src/lib/`, outside what I was asked to patch. A smaller step inside the asked-for directories is
   prototyped (`app-option-one-pass.prototype.patch`): one pass from the parsed result to the chart's
   arrays, the grid form made in idle time for the table, falling back to the two passes when a sample
   is off the grid. It gives what `alignSeries` then `toSpec` give on 200-odd random results (one
   test, passing). Estimated 10 to 20 ms at 200 series from the profile; **not measured**.
2. **Typed arrays through the chart's interface** (a gap as NaN, or the series' figures handed over
   with it): removes `toSpec`'s copy and the chart's own pass. It changes the chart's contract in about
   a dozen places that test for a gap, so it is a decision for `design/DECISIONS.md`, not a tuning step.
   Estimated 10 to 15 ms; not measured.
3. **The legend table's layout** (8 to 9 of the 13 to 15 ms of layout at every size): two cheap CSS
   changes did nothing; the cause was not found (the table sits in a container-query, sticky,
   scroll-timeline wrapper).

None of these is a two-step paint, and none changes what is drawn. With 1 and 2 together my estimate
for 200 series on the desktop is about 85 to 95 ms at the median from the body read, which leaves the
75th percentile near the limit: I would not promise the row. And **the harness needs a decision first**:
whether "from the last byte" includes DevTools' own copy of the body. With it, that row is about 200 ms
at 200 series whatever the page does.

## How to run it again

Two checkouts side by side, each with `app/`, `design-system/` and `dashboard/` (the app imports
it) and `node_modules` linked: `before` at `0aa0f7a`, `after` with the patches; `npm run build` in
each `design-system/` and then each `app/`. Ports 8931 (mock) and 8940 upward; nothing touches Cloudflare.

```
node tools/identity.cjs --builds before=<dir>,after=<dir> --rounds 2 --out identity.json --images diff/
VIZ_BEFORE=<before>/design-system/project/components/Chart/preview.html VIZ_AFTER=<after>/design-system/project/components/Chart/preview.html node --test model-equivalence.test.mjs
node tools/ab.cjs --builds before=<dir>/app,after=<dir>/app --skip typing,crosshair,local --series 200,36,12,4 --runs 20 [--phone] [--nobuffer] --out ab.json
node tools/profile.cjs --root <dir>/app --series 36,200 --runs 5 [--phone] [--table] [--frames] [--noprofiler] [--nobuffer]
node tools/summarise.cjs ab.json
```

Then, before the chart patch goes in: `node design-system/tools/build.mjs`,
`node design-system/tools/check.mjs design-system/project/components/Chart`, `cd design-system && npm test`.
