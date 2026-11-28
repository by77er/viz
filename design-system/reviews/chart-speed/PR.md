# Chart speed: a many-series result painted sooner (app-v9 review, B1)

## Where it stands, 2026-11-28

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
4. **The result's paint meets the budget** at 4, 12 and 36 series on both layouts by both
   definitions, and chart to table at 200 series on the phone is inside (91 ms, near the limit). **At 200
   series it is not**: the 75th percentile is 127 ms (body read) and 156 ms
   (last byte) on the desktop, 101 and 118 ms on the phone, down from 190 / 218 and 106 / 125 (paired
   medians −59 / −61 ms on the desktop, −20 / −15 ms on the phone). The medians on the phone, 79 and
   95 ms, are inside.
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
94 and 91; phone 36 chart to table after, 101; desktop 36 last byte after, 90) should be measured
twice by the review's rule: they were measured once, in one session.

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
fixes for the second review (`aa120dc`), and the earlier session ran on `0aa0f7a`; the cause was not
looked into, and before and after share it.

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

The two steps of 2026-11-28 were measured together, with the earlier patches, as one "after": the
lock that every browser run waits for (shared with three other builders, 10 to 30 minutes a turn)
left room for one complete alternating comparison per layout, not one per step. So their separate
shares are not measured; the profile after shows where the time now goes.

Not tried: a two-step or canvas rendering (it changes what a person sees: out of scope); decimating
points (721 points on a plot about 1,300 px wide); deferring the legend rows or the text form.

## Mutants

On copies in the scratch area, never in the tree. Every one was caught.

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

The 2026-11-27 mutant "x positions written to whole pixels" was not run again: path text is covered
by the markup hashes of `identity.cjs`, which compare it character for character.

## Waiver request: the result's first paint at 200 series

For a second reviewer. The rows: "Receives a result: paint it … 100 ms after it arrives", at 200 series,
both layouts, both definitions. Everything else in B1 is met in this session (above), the chart to
table row at 200 on the phone included, though near its limit.

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
| the app's e2e suites | | **not run** (Open items) |

## Open items

- **The waiver** above, for a second reviewer.
- `design-system/tools/speed.mjs` enables the Network domain with its buffers on (line 118): its figures
  for large bodies may carry the same DevTools cost. The system's owner should apply the same change
  there (or say why not).
- The harness's own copy of the body costs 10 to 20 ms after the last byte at 200 series (10 runs):
  take the two rows from separate runs, or accept it and say so.
- Rows within a tenth of their limit, measured once, in one session (see the budget table): a second
  session is needed before they are called passes.
- `app.patch` changes one frame a person sees (the waiting line goes one frame sooner): the app's
  reviewer.
- The app's e2e suites (`app.cjs`, `errors.cjs`, `dashboards.cjs`, `prod.cjs`) were not run on the
  patched app here: the app builder runs them on the shared tree and they need long turns of the lock.
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
```
