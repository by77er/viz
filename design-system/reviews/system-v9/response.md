# Design system v9: response to the v8 review

The input is `reviews/system-v8/review.md` (reject: one blocker, B1; no majors; minors m1 to m3) and its three images, and the
lead's decision on m3: "Colour the eight largest" is offered only when pressing it would change a colour, that is, when one of the
eight largest series on screen is not coloured ("every response meaningful" outranks "offered wherever a series is in Other").
Status: **reviewed, twice.** `review.md` rejected v9 on one blocker, the landing miss this response left open under B1, and says v9 can
be approved once that is settled by a fix or a recorded waiver. `second-review.md` **waived it** on 26 Nov: the miss is made by the
measuring tool. The record of the waiver, what is still not known, what reopens it and what changed in the tools is under "After the
reviews" at the end. Everything before that section is the response as the reviewers read it; where a statement in it turned out false,
it is marked "Corrected" in place and listed there.

"Before" is v8 exactly as it was on disk at the start of this session: a copy of `design-system/` (md5 of `src/components.css`
`7f3caf81…`, the review's commit) taken before any edit, in the session's scratch area; `npm run build` there reproduced the tree's
`dist/` byte for byte. Every failing-first run below ran against that copy. Nothing outside `design-system/` was edited; `flows/`,
`reviews/system-v8/` and earlier reviews and `app/` were not touched. Nothing was published or committed.

## How it was checked

All on this machine: 4 cores shared with other sessions, 16 GB. One browser and at most one test worker at a time (with two slips,
under Housekeeping), every server stopped. Each timing gives its load.

- **Reload while scrolled to a chart**, the review's B1 measurement, now part of `tools/audit.mjs` (`reload-shift`): every page with a
  chart, at 1500 px fine and 400 px coarse, reloaded while scrolled to **each** chart and jumped to each after load: 108 loads on v8,
  106 on v9 (the fixture has one chart fewer drawn: below), the layout shift and where the chart lands. Plus 720 px fine on the
  narrowed panel, by a scratch probe.
- **Reservations**: every chart's reserved height against what it draws, by `check.mjs` (every chart of the previews, in its markup,
  once drawn and after "Show 20 more of Other", at 1200 px fine and 400 and 320 px coarse) and by the audit (`reserve`, every chart on
  every page at its 14 configurations).
- **`npm test`**: the chart rules (21 tests, now with P8) and the corpus without its browser mutants.
- **Mutants**: the review's four survivors and v9's own, on copies in the scratch area, then the whole corpus (Mutants below).
- **`tools/audit.mjs`**: the full audit, 14 configurations and the reload pass; `tools/check.mjs` with its rendered audit.
- **Speed**: `tools/speed.mjs --compare`, v8's fixture and v9's alternating run by run; the crosshair and theme rows 20 runs a side,
  the full scenarios 10 runs a side (scaled down from 20 to fit a shared machine; said here). The load was low for most of these runs,
  so **every timing row below is judged** unless marked.
- **Images**: `tools/shots.mjs` (with a new `reload` step), v8 and v9 over a local server, same data and state, both themes, composed
  side by side in `compare/` (44 images, palette-encoded, none over 500 KB).

## Every v8 finding, at a glance

| v8 finding | Change | Shown by |
|---|---|---|
| **B1** a page reloaded while scrolled to a chart moves (0.18 to 1.69) and lands elsewhere | Every chart reserves what it draws, **in its markup** (the first frame of a load comes before the chart script); the reference chart sets the reservation again whenever it draws its legend; the legend's actions have a row each (two in one row wrapped at 320 px, 44 px past the reservation); the pages `tools/reference.mjs` builds preload the typefaces; `hidden` hides | Reload pass: v8 **68 of 108** loads fail (shift up to 0.88, landing up to 3,975 px away); v9 **0.0000 on every load** in three passes (318 loads), every chart lands in place but one in each of the first two passes, on the reference at 400 px coarse with no shift (an intermittent miss, open: below). `check.mjs` and the audit now read every chart. T1 to T3 caught. `compare/v9-b1-*` |
| **m1** V2b, V3, V4, V10 survive | `check.mjs`: colour longhands of every spelling, no `var()` in a property list, no duration without one, no rule undoing a chart's skipping; the audit: what each element eases as computed (at rest and hovered), colour transitions running when a change of theme is drawn, every chart's `content-visibility`, a ring drawn inside against the ink of its words | **Q2b, Q3, Q4, Q10 caught**, each through every tool that sees it (8 of 8 runs) |
| **m2** touch crosshair over 36 series at 49.6 ms against 50 | Two costs in the move handler removed: a computed-style read that restyled the page on every move, and a number formatter made on every call | Phone, judged, 20 runs: **v8 51 → v9 44 ms** at p75 (load 1.0 and 1.1); 10 runs: 50 → 44 (load 3.4 to 3.6) |
| **m3** "Colour the eight largest" offered when it would change nothing | Offered only when one of the eight largest on screen is not coloured (the lead's decision); `review.md`, `project/README.md` and the Chart README say so | P8 in `chart-rules.test.mjs` (failing first on v8: 11 of 21 tests); a fixed case for the review's image 02; C16 caught; `compare/v9-m3-*` |

## B1. A page reloaded while scrolled to a chart moved and landed elsewhere

### What was found here

The review's mechanism holds: a chart skipped off screen is as tall as its reservation, and most charts on the system's own pages
reserved far less than they drew. Reading it on v8 with the new checks found four more things on the same path, each fixed:

1. **A reservation set only by script comes too late.** My first version of the fix had the chart script set every reservation as it
   drew. Traced frame by frame on a reload of the Chart preview (`dist/preview/Chart.html` loads `viz-press.js` before the chart script),
   it still moved: the browser draws a first frame before the chart script runs, with the page 4,455 px
   tall instead of 6,597, restores the scroll position into that short page, then moves everything when the charts draw (shift 0.64).
   So the reservation has to be in the markup, as the README already said for an application ("from its last result"); the reference
   chart also sets it when it draws, so it stays true as the legend changes.
2. **The legend's two actions wrapped at 320 px**: "Show 20 more of Other" and "Colour the eight largest" in one row wrapped onto a
   second line, 44 px past what the rows reserve (the fixture's own 36-pod charts: 819.5 reserved, 863.5 drawn at 320 px coarse). The
   review measured 400 px and up, where they fit.
3. **The previews and the reference did not preload the typefaces** (`project/README.md`, Type, requires it). With every chart
   reserving exactly, a reload still shifted 0.0108 to 0.0154 at 1500 px: two descriptions rewrapped when the face arrived.
4. **`hidden` did not hide** a `.vz-chart` or a `.vz-page`, whose own `display` beat the browser's: the fixture drew its table panel's
   hidden chart as an empty box 265 px tall above the table, and its hidden Pods view below the dashboard (page 4,792 px tall; now
   3,294). The new `reserve` check found the empty chart ("reserves 264.5 px and draws 0 px"). The Panel preview's chart was likewise an
   empty box on its own page, where no chart script was loaded.

### What changed

- **Markup reservations** (`style="--legend-rows:N;--legend-notes:M"`, the last result's) on every chart of the Chart preview and the
  Panel preview (so in `dist/reference.html` and `dist/preview/`), and of the charts composition (`compositions/charts.html`, copied from
  v8's into `reviews/system-v9/compositions/`; the dashboard composition's "Memory by service" reserved a note line it does not draw:
  1 → 0).
- **The reference chart keeps its reservation** (`project/components/Chart/preview.html`, `legend()`): whenever it draws its legend it
  sets `--legend-rows` to the rows it drew and `--legend-notes` to its note lines (only when they change: the property is inherited, so a
  change restyles the chart).
- **One action to a row** in the legend (`tr.vz-legend-actions`, each a legend row tall), so nothing in a chart wraps and
  `--legend-rows` counts what is drawn from the data alone, at every width. The coarse-pointer padding the shared row needed was removed
  (a legend row is 45 px and its button is centred in it).
- **Preloads** in every page `tools/reference.mjs` writes; a preview holding a reference chart loads `../viz-chart.js`.
- **`.vz [hidden] { display: none !important }`** (`project/README.md`, Layout).
- **Docs**: Chart README ("Reserved height", "Off screen", rule 6), `project/README.md` (Responsiveness: the reservation is in the
  markup; the audit's reload check), `review.md` (Narrow and zoom: reloaded scrolled to each chart, landing where it was), `method.md`
  (step 7), the fixture README (what the page draws changed).

Skipping (`content-visibility: auto`) is kept everywhere: the review's other option, skipping only where the reservation is exact, was
not needed once every reservation is exact, and is not checkable in CSS.

### What guards it now

- **`check.mjs`** reads **every** chart of the previews (v8: only those that set `--legend-rows`), at 1200 px fine and 400 and 320 px
  coarse, three ways: the reservation in its markup (the page rendered with its scripts left out; a chart that draws legend rows with no
  `--legend-rows` there fails as "no reservation"), once drawn, and after "Show 20 more of Other"; each against what it draws laid out;
  and each chart's computed `content-visibility`. Today: 11 charts, reserved = drawn in all three readings at all three widths
  (`evidence/check.txt`).
- **`tools/audit.mjs`**: `reserve` and `skip` on every chart of every page at all 14 configurations, read as the page opened;
  `font` (the sans face preloaded); and the **reload pass** (`reload-shift`), at both layouts: every chart (`--quick`: the middle one and
  the last), a layout shift of 0.05 or more or a landing more than 1 px away fails, judged at any load; a failure prints the scroll
  position and page height frame by frame. Before the reloads, every page with a chart is also loaded **with no script run**, and each
  chart's reservation there must be what it draws (`reserve`): the deterministic form of the reload check, added after the first whole
  corpus run, where T3.audit survived (below). On the v8 copy it fails every chart of the Chart preview at both layouts ("reserves 264.5 px
  in the page as served, before any script, and draws 365.5 px"); on v9 it passes on every page.
- Mutants: **T1** (the script no longer keeps its reservation: caught after "Show 20 more of Other"), **T2** (two actions in one row:
  caught at 320 px and in the markup), **T3** (a chart with no markup reservation: `check.mjs`) and **T3.audit** (four charts without:
  first caught by the reloads, landing 1,178 px away; in the first whole corpus run it **survived**, because whether a reload shows it
  depends on whether the browser draws a frame before the chart script; now caught every time by the served-page reservation), **T6** (no preload: `font`), **Z6** rewritten (below).
- **Corrected, 26 Nov (second review): what kills T3.audit, and where it survives.**
  - **Killed by `reserve` only**: each chart's reservation in the page as served with no script run, at both layouts, in every run
    (measured here on 26 Nov: 4 findings at 1500 px and 4 at 400 px in 6 of 6 runs, with the shipped pass and with the changed one).
  - **It survives the reload pass's own two measures, layout shift and landing, at both layouts, in some runs.** Measured here, a run
    being every chart of the Chart preview or `--quick`'s two: with the changed pass the reloads at 400 px had a finding in 2 of 4
    runs, and at 1500 px in 2 of 4; with the pass as shipped, at 400 px in **0 of 2** runs, at 1500 px in 2 of 2. No reload landed
    elsewhere in any of these runs (0 of 88 reloads). The second reviewer's runs: not caught at 400 px in two runs of each pass.
  - "First caught by the reloads, landing 1,178 px away" above **was not a catch**. That finding had a layout shift of 0.0000 and was
    the emulator's landing miss, which the second review reproduced on this mutant under the shipped pass (its E10).
  - Why 400 px was blind: the shifts this mutant causes come in the first half second of a load, and with `isMobile` the browser marks
    those as following input. The shipped pass summed only unmarked entries, so its reloads at 400 px could not show the mutant at
    all. With every entry counted they show it when the browser happens to draw a frame before the chart script (0.4184 and 0.8565
    here), which is still not every run. `evidence/second-review-t3-audit.txt`.

### Measured: reload while scrolled to a chart

The audit's reload pass on the v8 copy and on v9, at a load of 0.1 to 8.4 (layout shift is judged at any load). Shift is the reload's
cumulative layout shift; "landed" is how far the chart is from where it was before the reload. `evidence/reload-v8.txt`,
`evidence/reload-v9.txt` (every load), `evidence/reload-720-node-b.txt`.

| Page, chart, layout | The review (v8) | v8, here | v9, here |
|---|---|---|---|
| Chart preview, "the query narrowed to node-b", 400 coarse | 0.81, lands 1,041 px away | 0.0000, in place (also in the image) | **0.0000, in place** |
| the same, 720 px fine | 0.50, 915 px away | 0.90 + 0.24, then in place (twice) | **0.0000, in place** (twice) |
| the same, 1500 px | 0.18, 915 px away | 0.7157, in place (0.0985 on the jump) | **0.0000, in place** |
| Chart preview, "Memory by service", 400 coarse | 1.14, 719 px away | 0.0000, lands 595 px away | **0.0000, in place** |
| the same, 1500 px | — | 0.7903, lands 408 px away | **0.0000, in place** |
| Chart preview, "Request rate, change on last week", 400 coarse / 1500 | 1.69 / — | 0.0000, in place / 0.7772 | **0.0000, in place** at both |
| Chart preview, "Error ratio, if this rule had existed", 400 coarse / 1500 | 0.90 / — | 0.0000, in place / 0.7903 | **0.0000, in place** at both |
| Chart preview, "three of Other picked out", 400 coarse / 1500 | — | lands 1,535 px away / 0.1898, 915 px away | **0.0000, in place** at both |
| Reference, the narrowed panel (light and dark columns), 400 coarse | 0.80 | jump 0.33; one lands 1,837 px away | **0.0000, in place** |
| the same, 1500 px | — | 0.8825 | **0.0000, in place** |
| Charts composition, its last chart, 400 coarse / 1500 | 0.046, 637 px lower | lands 383 px away / 0.1764 | **0.0000, in place** at both |
| Fixture, charts 3 and 5; dashboard composition, chart 5; 400 coarse | 0.0000, in place | 0.0000, in place (fixture chart 4: lands 494 px away) | **0.0000, in place** |

Over every load:

| | Loads | Fail | Largest reload shift | Largest jump shift | Farthest landing |
|---|---|---|---|---|---|
| v8 copy | 108 | **68** | 0.8835 (reference, 1500) | 0.8400 (reference, 400 coarse) | 3,975 px (reference, 400 coarse) |
| v9, the audit's reload pass | 106 | **1** | **0.0000** | **0.0000** | 759 px, once (below) |
| v9, the final full audit's reload pass | 106 | **1** | **0.0000** | **0.0000** | 6,760 px, once (below) |
| v9, the last reload pass (with the served-page check), 26 Nov | 106 | **0** | **0.0000** | **0.0000** | 0 px: every chart in place |

My runs of v8 differ from the review's in detail: at 400 px coarse I measure no layout shift but a landing far away (the restored
position points into a page made shorter by the skipped charts above it), where the review measured both. Both are B1, and both are
gone in v9.

**Settled after review, 26 Nov: waived by the second reviewer as the measuring tool's doing** ("After the reviews", below). The
paragraph that follows is kept as written; its "cause not found" and its rate (three in about 330) no longer stand.

**Not fixed, open: an intermittent landing miss at 400 px coarse.** Three times in v9, a reload at 400 px coarse came back with the
scroll position somewhere other than where it was, with **no layout shift**:
- the reference, chart 1 of 22: 759 px short (the first reload pass, `evidence/reload-v9.txt`);
- the Chart preview's "Memory by service": 369 px short (an image capture, `evidence/missed-reload-memory-400-coarse-light.png`; the
  image in `compare/` is a retake);
- the reference, chart 22 of 22: **6,760 px past** where it was (the final full audit, `evidence/audit-full.txt`). Its frame-by-frame
  trace has one entry: the first frame, 278 ms after the reload, was already the whole page (52,387 px tall) and already at 51,350 px.

None came back on a retry, and the last full reload pass (106 loads, `evidence/reload-v9-final.txt`) had none: 22 more reloads of every reference chart, 44 in a second reload pass, 38 of the memory chart and three
retakes all landed in place, and it never happened at 1500 px (about 330 reloads of v9 in all). What I ruled out: the page is the same
height before and after its scripts (each panel measured with scripts off and on), and with the fallback face or the web face (the
Chart preview to the pixel; the reference within 30 px per section), and every chart reserves what it draws; the last trace shows a
complete page restored to a position the person was never at. So the page does not move under the person; the browser restores to the
wrong place, and I could not find why. It is reported as a gap, not a pass: the audit fails on it (as it did in the final run) and prints
the trace with every occurrence. Next: run the reload pass with `content-visibility` switched off to see whether skipping is involved,
and on a real phone.

### The theme change, with the skipping kept

Skipping was the theme fix's tool, and no chart lost it. Measured on the fixture page (a floor), CPU 4x, Fast 4G, v8's and v9's
fixture alternating; p75 (median, worst), all judged:

| Theme change (to dark) | Budget | v8 | load | v9 | load |
|---|---|---|---|---|---|
| Phone, 20 runs (theme and crosshair rows) | 100 | 68 (59, 116) | 1.0 | **69** (60, 109) | 1.1 |
| Desktop, 20 runs | 100 | 79 (73, 96) | 2.3 | **81** (68, 118) | 2.3 |
| Phone, 10 runs (full scenario) | 100 | 88 (75, 104) | 3.5 | **99** (74, 116) | 3.6 |
| Desktop, 10 runs (full scenario) | 100 | 93 (81, 195) | 3.6 | **72** (68, 91) | 3.5 |
| Transitions running when it is drawn, every run above | 0 | 0 | any | **0** | any |

Within budget in every judged run. The phone's 10-run figure, 99 ms, has 1 ms of margin; the 20-run measurements (69, judged; 79 in an
A/B run at a load near 4, not judged: `evidence/speed-phone-rows-nohidden-ab.txt`) do not repeat it, and nothing in v9 runs on that path (the reservation is written when a legend is drawn, not on
a theme change). I report it as within, with thin margin on one 10-run sample.

## m1. Four mutants survived every check

| Mutant (the review's name) | Broken | Now caught by | First line printed |
|---|---|---|---|
| **Q2b** (V2b) | `.vz-button { --vz-p: background-color, border-color; transition-property: var(--vz-p); … }` | `check.mjs`: a property list taken from a custom property cannot be read and fails; **Q2b.audit**: the audit reads `background-color, border-color` eased as computed, and 30 colour transitions running when a change of theme is drawn (Button preview) | `.vz-button transitions var(--vz-p) …: no colour is eased …` |
| **Q3** (V3) | `.vz-input { transition: border-block-end-color …, border-inline-start-color … }` | `check.mjs`: every property that carries a colour, logical longhands and shorthands included; **Q3.audit**: eased as computed, and 12 transitions on a change of theme, on the Field preview (the fixture has no input, as the review said; the audit counts on every page instead of adding one to the fixture) | `.vz-input transitions border-block-end-color …` |
| **Q4** (V4) | `.vz-panel .vz-chart { content-visibility: visible }` | `check.mjs`: a rule that targets a chart and sets anything but `auto`; **Q4.render**: `check.mjs`'s rendered pass reads each chart's computed value; **Q4.audit**: the audit's `skip`, every chart on every page as it opened | `.vz-panel.vz-chart sets content-visibility: visible …`; `skip … computes content-visibility: visible` |
| **Q10** (V10) | `.vz-nav a { padding-inline: 0; margin-inline: 0 }` | the audit's focus guard: a ring drawn inside a control keeps a hairline clear of the ink of its words (each run's box narrowed to its glyphs by the face's measured ascent, descent and side bearings) | `"Explore" focused: its ring is drawn inside it and lies 1.8 px over its letters` |

Also caught, on the same paths: **T7** (a `transition-duration` with no property list in its rule: it eases the initial list, `all`,
colours included; neither the review's mutants nor v8's check had this one).

**The claims the review found false, corrected.**
- v8 said "`check.mjs` confirms reserved equals drawn". It read only charts that set `--legend-rows`. Now it reads every chart, in its
  markup and once drawn and after the legend grows, at three widths, and fails a chart with no reservation; the audit reads every chart
  on every page at every configuration. As a statement now: "every chart reserves what it draws: `check.mjs` reads every chart of the
  previews, `tools/audit.mjs` every chart of every page, and the reload pass reloads each".
- v8 said "`check.mjs` fails any transition of a colour (or `all`)". It read `transition-property` literally and knew no logical
  longhands. Now it fails a colour property of any spelling, a property list taken from a custom property, and a duration with no
  property list; what it cannot read (a transition set from script, a later rule's effect) the audit reads as computed. `project/README.md`
  (Motion) now says exactly that.

**Found by the new ring check, fixed.** With a hairline of clearance required, the check found two rings drawn inside that touched
their letters in v8 (0 px from the ink), which the review's V10 did not cover: the navigation's links at the fine pointer (above and
below: the descender of "Explore") and the legend's sort buttons ("Last, ms": the comma and parentheses). Navigation links now have
`space-1` round their words (the sides given back by the margin, as before; the bar is 48 px and its height did not change); the
legend's sort buttons fill their head with `space-1` less the head's rule above and below (the head stays 24 px, so no reservation
changes). Images: `compare/v9-m1-nav-focus-*`, `compare/v9-m1-legend-sort-focus-*` (the ring taller, clear of the words). Mutants
**T4** and **T5** (each room removed) are caught. A first attempt gave every `vz-sort` `space-1` all round; in the legend's
right-aligned heads that put the button 1.5 px below its head and the ring was cut (the focus guard said so), so the change is the
legend's only.

## m2. The touch crosshair over 36 series had no margin

**The cause** (`evidence/crosshair-trace.txt`; a CPU profile of 40 touch moves on the fixture's 36-pod plot, phone layout, CPU 4x):
of 8 to 10 ms of script per move, 6 to 7.5 ms was `getPropertyValue`: the chart's `tokens().sp(k)` read the computed style each time it
was called, and the move handler calls it after writing the readout, so every call restyled the page. Another 3 ms was `toLocaleString`,
which builds a number formatter on every call.

**The change** (`project/components/Chart/preview.html`, the source of `dist/viz-chart.js`): the spaces are read once per draw with the
other tokens; one `Intl.NumberFormat` per number of decimals, made once (same output). Script per move 6.75 → 4.0 ms, the whole task
31 → 27 ms (both at load 6.7, one after the other).

**Measured** (fixture page, a floor; CPU 4x, Fast 4G; v8 and v9 alternating; p75 (median, worst)):

| Crosshair | Budget | v8 | load | v9 | load | |
|---|---|---|---|---|---|---|
| Touch drag, 36 series, phone, 20 runs | 50 | 51 (45, 68) | 1.0 | **44** (40, 57) | 1.1 | judged; v8 over, v9 within |
| the same, phone, 10 runs (full scenario) | 50 | 50 (45, 54) | 3.6 | **44** (41, 50) | 3.4 | judged |
| the same, 20 runs, v9 without the `hidden` rule against v9 | 50 | 47 (42, 57) | 3.9 | 50 (41, 60) | 3.8 | A/B, the first judged, the second not (10 of 20 samples above 4) |
| Pointer, 36 series, desktop, 20 runs | 50 | 33 (26, 37) | 2.2 | **27** (24, 31) | 2.3 | judged |
| Pointer, 200 series, desktop, 20 runs | 50 | 32 (28, 42) | 2.2 | **27** (23, 58) | 2.3 | judged |
| Pointer, 36 / 200 series, desktop, 10 runs | 50 | 46 / 39 | 3.6 | **27 / 26** | 3.7 | judged |

**Margin, said plainly**: at a low load the phone's touch crosshair is 44 ms against 50 (6 ms); at a load near the core count one 20-run
measurement (not judged) came out at 50. The rest of the time is the browser repainting the plot's SVG for the crosshair group and
laying out the legend's figure column and the readout ("(program)" and layout in the trace). Removing that is not cheap: the crosshair
would move into its own layer over the plot, a structural change to the chart, and its legend figures would need to stop laying out the
table. Not done; the budget is unchanged. The A/B row shows the `hidden` fix (which made the fixture page shorter) is not where the
gain comes from.

## m3. "Colour the eight largest" offered when pressing it would change nothing

**The rule** (the lead's decision): offered only when one of the eight largest series on screen, ranked as the recolour ranks them,
is not coloured. At load, after a narrowing that coloured the eight largest left, and right after it was pressed, it is not offered.
`legendActions(model)` returns `['more']` or `['more', 'recolour']`. Pressing it still gives slots by rank (rule 5), so it can also move
colours among the eight; when all eight are coloured it is not offered even if their slots are not in rank order, because it would only
reorder colours, which is not what the button says.

**Wording.** `project/review.md`, Many series: "Is 'Colour the eight largest' offered exactly when pressing it would change a colour,
that is, when one of the eight largest series on screen is not coloured, and never when the eight largest are already coloured (the
project lead's decision, v9 …)?". `project/README.md`, Colour, and the Chart README (rules 3, 5, 6 and 7) say the same; rule 7 now says
the note's first sentence ("N in Other are now larger than a coloured series") comes with the offer and the second ("8 coloured by size;
28 in Other") without it (they can differ only where two series have the same highest value).

**Tests** (`tools/test/chart-rules.test.mjs`, 21 tests, 21 pass):
- **P8**, checked after every step of every random sequence (400 sequences, 300 twin sequences, every fixed case): offered exactly when
  one of the eight largest on screen is grey; when offered, pressing it (on a copy of the map) colours every one of them.
- A fixed case for the review's image 02: at load only "Show 20 more of Other" (pressing the recolour at load changes no slot, checked);
  narrowed to node-b, not offered; widened back, offered; pressed, not offered; a pod larger than all arrives, offered again.
- The v7 review's M1 case now expects no offer after the narrowing (the eight largest on node-b are coloured) and the offer after
  widening back.
- **Failing first on v8** (`evidence/chart-rules-on-v8.txt`): 11 of 21 fail, every one on P8 ("the eight largest on screen are all
  coloured and 'Colour the eight largest' is offered"); with P8 left out (`VIZ_NO_OFFER=1`), 2 fail, the two fixed cases above, so v8's
  colours are otherwise what v9's are.
- Mutants: **C16** (v8's offer) caught. **C15** (v7's offer: only when a member of Other is larger than a coloured series) now passes:
  under v9's rule the two agree except where two series have the same highest value, which no test draws, so it is an equivalent edit;
  it is kept in the corpus as a harmless one, with that reason.

Images: `compare/v9-m3-pods-at-load-*` (v8 offers it at load; v9 does not), `-narrowed-and-widened-back-*` (both offer it; in v9 on a
row of its own), `-after-colour-the-eight-largest-*` (v8 still offers it; v9 does not).

## Speed

`tools/speed.mjs --compare`, both shipped scenarios, v8's fixture and v9's alternating run by run, **10 runs a side, not 20** (scaled
down to fit a shared machine), then the crosshair and theme rows alone at 20 runs a side (above). Measured here on the fixture page (a
floor, not the application), CPU 4x, Fast 4G, 4 cores. Calibration 238 to 300 ms (context only). Every row judged.

**v9's fixture is not v8's page.** With `hidden` hiding, v9's fixture no longer draws the table panel's empty chart or the hidden Pods
view: 1,498 px less page and fewer elements to restyle, and "Move to a view whose data is not loaded" now shows a view that was hidden
(in v8 it was already drawn). The A/B in m2 shows this is not what moves the crosshair.

p75 (median), ms; load is the median at that row's samples:

| Phone, 400 x 800, coarse, touch | Budget | v8 | v9 | load (v8 / v9) |
|---|---|---|---|---|
| Press: Run query | 50 | 24 (16) | 22 (19) | 3.6 / 3.4 |
| Typing in the query editor | 50 | 23 (20) | 23 (16) | 3.6 / 3.4 |
| Crosshair by touch drag, 36 series | 50 | 50 (45) | **44** (41) | 3.6 / 3.4 |
| Legend row toggle, 36 / 200 series | 100 | 76 (71) / 65 (54) | 70 (58) / 64 (58) | 3.5 / 3.4 |
| One panel to table, 36 / 200; to chart, 36 | 100 | 80 / 78; 51 | 65 / 68; 68 | 3.4 / 3.7 |
| Open a menu (Share…) | 100 | 37 (33) | 40 (34) | 3.4 / 3.7 |
| Change theme (to dark) | 100 | 88 (75) | 99 (74) | 3.5 / 3.6 |
| Transitions running when the theme change is drawn | 0 | 0 | 0 | any |
| Run a query: sent, waiting state shown | 100 | 43 (34) | 37 (32) | 3.4 / 3.6 |
| Move to a view whose data is not loaded | 100 | 42 (37) | 53 (42) | 3.6 / 3.6 |
| Response to paint, 36 / 200 series | 100 | 13 / 28 | 13 / 27 | 3.6 / 3.5 |
| Worst interaction (Event Timing) | 200 | 96 (88) | 104 (88) | 3.6 / 3.4 |
| Layout shift: load and run; loaded scrolled to each of five charts | 0.05 | 0.0000 everywhere | 0.0000 everywhere | any |

| Desktop, 1440 x 900, fine | Budget | v8 | v9 | load (v8 / v9) |
|---|---|---|---|---|
| Press: Run query | 50 | 22 (18) | 17 (15) | 3.5 / 3.6 |
| Typing in the query editor | 50 | 18 (15) | 19 (14) | 3.6 / 3.7 |
| Crosshair, 3 / 36 / 200 series | 50 | 35 / 46 / 39 | 28 / **27** / **26** | 3.6 / 3.7 |
| Legend row toggle, 36 / 200 series | 100 | 67 / 51 | 57 / 52 | 3.6 / 3.5 |
| One panel to table, 36 / 200; to chart, 36 | 100 | 55 / 49; 37 | 49 / 42; 50 | 3.7 / 3.5 |
| Open a menu (Share…) | 100 | 29 (19) | 23 (19) | 3.6 / 3.5 |
| Change theme (to dark) | 100 | 93 (81) | 72 (68) | 3.6 / 3.5 |
| Transitions running when the theme change is drawn | 0 | 0 | 0 | any |
| Run a query: sent, waiting state shown | 100 | 30 (21) | 28 (23) | 3.7 / 3.5 |
| Move to a view whose data is not loaded | 100 | 29 (21) | 32 (24) | 3.6 / 3.4 |
| Response to paint, 36 / 200 series | 100 | 28 / 28 | 33 / 27 | 3.6 / 3.4 |
| Worst interaction (Event Timing) | 200 | 120 (96) | 112 (104) | 3.6 / 3.4 |
| Layout shift: load and run; loaded scrolled to a chart | 0.05 | 0.0004; 0.0002 | 0.0004; 0.0002 | any |

Every row within budget at both layouts, before and after. Beyond the crosshair, no row moves in one direction at both layouts by more
than its own spread between runs; "Move to a view whose data is not loaded" is slower on the phone (42 → 53 ms), as expected now that
it really shows a view. Printed: `evidence/speed-*.txt`; results: `speed/*.json`.

## Also changed, found while doing the above

- **Z6 rewritten.** It removed the action row's touch padding, which kept wrapped buttons' hit areas off the row above. With one action
  to a row nothing wraps; the padding was redundant, Z6 survived as an equivalent mutant (first run here), and the padding was removed.
  Z6 now draws the action rows shorter than a legend row with a coarse pointer, so a button's 44 px reach the row above: caught
  (`reserve`, `hit-area`).
- **The audit's reload pass, first version, misread itself**: loading the same address twice in one page is taken by the browser as a
  reload with the scroll restored, so a chart measured after another could land "18 px away" on a page that had not moved. Each chart now
  gets a page of its own; the numbers above are from the corrected pass only.
- **The audit's theme count** first counted every running transition; a measured progress bar still moving from load was counted once.
  It now counts colour transitions only.
- The v9 compositions are v8's, copied, with the charts composition's reservations, the dashboard's note count and the secret
  composition's missing font preload (the new `font` check) fixed. The mutants that named v8's compositions now name v9's.

## Images

`compare/` (44: 22 states, both themes; v8 left, v9 right, each composed by `tools/shots.mjs compare` from captures over a local server,
same data and state; the 400 and 320 px states with a coarse pointer and touch):

| Image | Shows |
|---|---|
| `v9-b1-reload-scrolled-to-node-b-{1500,400-coarse}-*` | The window 2 s after a reload while scrolled to "the query narrowed to node-b". 1500: v8 shifted 0.7157 (light) and 0.1831 (dark) on the way; v9 0.0000. At 400 coarse this capture of v8 happened to land in place (it does not always: the table above) |
| `v9-b1-reload-scrolled-to-memory-{1500,400-coarse}-*` | The same for "Memory by service": v8 restored to 5,647 px instead of 5,239 (1500, shift 0.79) and 7,475 instead of 7,250 (400 coarse): the window shows another panel; v9 in place, 0.0000 |
| `v9-b1-legend-two-actions-{1440,320-coarse}-*` | The "against the limit" legend: v8's two actions share a row and wrap at 320 px; v9 one to a row |
| `v9-m3-pods-*` | m3, as above |
| `v9-m1-nav-focus-*`, `v9-m1-legend-sort-focus-*` | The rings drawn inside, now clear of the words (at 1440; at 400 coarse unchanged) |
| `v9-fixture-table-panel-1440-*`, `v9-fixture-full-1440-*` | The fixture: v8's empty 265 px chart box above the Pods table and the hidden Pods view drawn at the bottom; v9 neither |
| `v9-dashboard-*`, `v9-charts-*` | The dashboard and charts compositions at 1500 and 400 coarse, for regressions: none seen besides the action rows |

Judged on the composed images: the action rows read as a short list of what can be done with Other; at 1440 px with both actions
offered the legend is one 25 px row taller than v8's. No regression found.

## Final runs on the tree as it is now

- **`tools/audit.mjs`**, full: 56 pages × 14 configurations, the reduced-motion pass, then the reload pass (13 min at a load of 4.9 to
  6.2; `evidence/audit-full.txt`). **System pages: 1 finding**, the reload miss above (the reference, 400 px coarse). Every other check,
  the new `reserve`, `skip`, `font`, eased colours, theme-change transitions and the ring against its words included: none. Flow screens
  (read only, reported apart): 122 findings, the same kinds as v8's (`press`: they do not load `viz-press.js`; `fold-scroll` on screens
  1, 8 and 12; screen 1's link in a sentence); the new checks add nothing there.
- **`tools/check.mjs`** with its rendered audit: 873 of 873 checks, 30 previews in both themes at rest, hover, press and a finger's press
  with 0 failures; 11 charts reserved = drawn in their markup, once drawn and after "Show 20 more of Other", at 1200, 400 and 320 px;
  0 literal values. On the previews, the compositions and the fixtures (`--no-render`): 759 of 759, 0 literal values in 45 files
  (`evidence/check.txt`). `tools/shots.mjs` and `tools/reference.mjs` lint as before (the review frame's 24 literals in `shots.mjs`,
  unchanged from v8).
- **`npm test`**: 197 tests, **139 pass, 0 fail**, 58 skipped (they need a browser and ran in the corpus run): the 21 chart tests and
  the 118 corpus mutants that need none (80 s; `evidence/npm-test.txt`).
- **`tools/mutants.mjs`**, the whole corpus on copies: **176 of 176 as expected** (170 caught, the 6 harmless edits pass,
  C15 among them), 22 min at a load of 9.1 to 10.2 on 26 Nov (`evidence/mutants.txt`): R 18, N 13, X 32, V 17, Y 20, Z 8, W 13, U 15,
  Q 8, T 8, C 16, A 4, H 4. The first whole run, on 19 Nov, had one mutant not as expected: **T3.audit survived**
  (`evidence/mutants-first-run-19-nov.txt`); it had been caught in the run of new mutants an hour before. Whether a reload shows a
  missing markup reservation depends on whether the browser draws a frame before the chart script, so the reload pass alone was not a
  dependable guard. The audit now also reads every chart's reservation in the page as served with no script run (B1, "What guards
  it"), which catches T3.audit every time; T3.audit expects that finding. (Corrected, 26 Nov: it is the only measure that does. The
  reloads of the reload pass do not catch T3.audit dependably at either layout: B1, "What guards it now".) The session was stopped by a usage limit after that first run
  and resumed on 26 Nov; the served-page check, the last reload pass, this corpus run and `npm test` (197 tests, 139 pass, 0 fail, 58
  skipped) are from 26 Nov.

## Migration (for the flows and the app, to be re-imaged on v9)

**No class was renamed or removed. No token was added or removed** (`version` 9).

- **Charts reserve in their markup.** A chart sets `--legend-rows` and `--legend-notes` from its last result in the markup it is
  served with, so the first frame of a load is the height it will draw. `--legend-rows` now counts every row the legend draws: the
  coloured series and, when there is an Other, its row, the members shown and **one row per action** (v8 counted the action row once).
  The reference chart (`dist/viz-chart.js`) sets both again whenever it draws its legend; code that sets them itself is overwritten by
  what is drawn.
- **The legend's actions have a row each** (`tr.vz-legend-actions`, one button in each): "Show 20 more of Other" (or "Hide the N in
  Other") and, only when it would change a colour, "Colour the eight largest". The coarse-pointer padding on the action row is gone
  (a legend row is 45 px and its button is centred in it).
- **"Colour the eight largest"** is offered only when one of the eight largest series on screen is not coloured
  (`vzChartRules.legendActions(model)` returns `['more']` or `['more', 'recolour']`; v8 returned both whenever Other had members).
- **`hidden` hides** inside `.vz` (`.vz [hidden] { display: none !important }`): an element that relied on its component's display to
  stay drawn while `hidden` was set is now hidden, as the attribute says.
- **Focus rings drawn inside** keep a hairline clear of their words: navigation links have `space-1` of padding on every side (the sides
  given back by a negative margin, as before; the bar's height is unchanged); the legend's sort buttons fill their head with
  `space-1` less the head's rule above and below. No other control changed.
- **Pages built by `tools/reference.mjs`** preload both typefaces; a preview holding a chart of the reference's (`data-demo`) loads
  `../viz-chart.js`.
- **Transitions**: a component may not write `transition-property` with `var()`, nor a non-zero `transition-duration` without a property
  list in the same rule; a logical colour longhand is a colour (`check.mjs`).
- **Tools**: `tools/audit.mjs` adds the kinds `reserve`, `skip`, `font` and `reload-shift`, `motion` findings for eased colours and
  theme-change transitions, and the ring-against-ink read in `focus`; `--reload-only` and `--no-reload`. `tools/check.mjs` reads every
  chart's reservation. `tools/shots.mjs` has a `reload` step. The corpus adds Q2b, Q3, Q4, Q10 (with their `.audit` and `.render` runs),
  T1 to T7 and C16; C15 became a harmless edit; Z6 was rewritten.

## What did not work, and what was not done

- **The intermittent landing miss at 400 px coarse** (B1, above): three in about 330 reloads, no layout shift, cause not found; the
  final full audit fails on it. Open. (26 Nov: the first reviewer measured it far more often and made it the blocker; the second
  reviewer found the cause, the measuring tool, and waived it: "After the reviews".)
- **The crosshair's remaining time** is the plot's repaint and the legend's layout; moving the crosshair to its own layer is not done.
  Margin 6 ms at a low load; at a load near 4 one measurement reached 50.
- **The theme change on the phone** came out at 99 ms in one 10-run sample (69 in the 20-run one): within, but thin there.
- **The fixture changed under the measurements** (`hidden`), so v8 and v9 fixture numbers are not the same page; the attribution A/B was
  run for the crosshair and the theme on the phone only.
- **20 runs** only for the crosshair and theme rows; the full scenarios ran 10 a side.
- `design/DECISIONS.md` is outside `design-system/`; the lead's m3 decision is recorded in the rubric, the README and the Chart README
  (rule 5 says what it replaces). An entry there is for the owner of `design/`.
- The flow screens and the app are not re-imaged on v9 (`flows/` and `app/` were not to be edited). The new checks find nothing new on
  the flow screens: their findings are the known `press`, `fold-scroll` and `sentence-link` ones.
- Not checked: a screen reader by ear, Safari and Firefox (whether they restore a reload's position the same way is not known), real
  touch hardware.

## Files

- `project/components/Chart/preview.html` (the one source of `dist/viz-chart.js`): the reservation set when the legend is drawn; one
  action to a row; `legendActions` (m3); the spaces read once per draw and one number formatter per precision (m2); every chart's
  markup reservation.
- `project/components/Panel/preview.html`: its chart's markup reservation.
- `src/components.css`: `.vz [hidden]`; the navigation link's `space-1` round its words; the legend heads' sort buttons; the action row's
  coarse padding removed. Generated from it: `project/components/bundle.css`, `dist/`.
- `project/tokens.json` (`version` 9; no token added or removed), `project/README.md` (Colour: the offer; the focus ring drawn inside;
  Responsiveness: the reservation in the markup and the reload check; Motion: what the checks read; Layout: `hidden`), `project/review.md`
  (Many series: the offer; Narrow and zoom: reloaded scrolled to each chart), `project/method.md` (step 7), Chart README (rules 3, 5, 6, 7;
  "Reserved height"; "Off screen"; the legend's heads), Nav README (the ring's room), `fixtures/README.md` (what the page draws changed).
- Tools: `audit.mjs` (`reserve`, `skip`, `font`, the reload pass with `--reload-only` and `--no-reload` and each chart's reservation in the page as served with no script, eased colours as computed at rest
  and hovered, colour transitions on a change of theme, the ring against the ink of its words, the header), `check.mjs` (every chart's
  reservation in its markup, once drawn and after the legend grows, at three widths; `content-visibility`), `lib/structure.mjs` (colour
  properties of every spelling, no `var()` property list, no duration without a list, no rule undoing a chart's skipping),
  `reference.mjs` (preloads; the chart script for a preview with a chart), `shots.mjs` (the `reload` step), `mutants-corpus.mjs` (Q, T,
  C16; C15 harmless; Z6 rewritten; v9's compositions), `mutants.mjs` (group names), `test/chart-rules.test.mjs` (P8, the m3 case, the M1
  case's offer).
- `reviews/system-v9/`: this file; `compositions/` (v8's, with the charts composition's reservations, the dashboard's note count, the
  secret composition's preload); `shots-compare.json` (the image scenario; `system-vN` stands for v8's or v9's compositions);
  `compare/` (44 images); `speed/` (results); `evidence/` (the runs as printed).
- `README.md` (version 9, the tools, the corpus, history, what is open).

## Housekeeping

- Every mutant ran on a copy under the session's scratch area, deleted after its run (the runner refuses a directory inside the tree).
  No edit is half-finished; the final runs above are on the tree as it is now.
- **Slips, said plainly.** Twice a second browser of mine ran while one was already running: `check.mjs` during my first background
  reload pass (I stopped that pass; none of its output is used) and `check.mjs` during the first quick audit (superseded by a second run,
  which is the one used). From then on every browser job ran alone. Also, a first reload pass of v9 was started before the Panel
  preview's markup was fixed and `dist/` was rebuilt under it; it was stopped and not used.
- Git: read-only commands only (`git status`, `git log`, `git diff --stat`, `git show --stat`), to see what had changed; the lead's
  work-in-progress commits in this period took in parts of this work as it stood. Nothing was committed or pushed by me.
- Servers: the local static servers I started for the images (port 8971), and those the audit, the harness and the probes start, all
  stopped; no process of this session is left running. Another session's `mutants.mjs` (in another project) was running on the machine;
  it was not touched.
- The scratch copies (v8 as handed off, v9 without the `hidden` rule, the mutant copies), the raw captures and the probes were deleted at
  the end; the probes' results that this file uses are in `evidence/`.
- The session stopped on 19 Nov at a usage limit while the corpus was running, and resumed on 26 Nov; no one else edited `design-system/`
  in between. The background runs of 19 Nov were gone; the corpus was run again (above).
- No Cloudflare resource was touched; nothing was published.

## After the reviews: B1 waived by a second reviewer, and what changed because of it (26 Nov)

The rubric: "A blocker may be waived only by a second reviewer, who records why." The reviewer's record is `second-review.md`. This
section is the author's side of it: what was waived and on what evidence, what is not known, what reopens it, and the changes that
review required. **Nothing in the system's CSS, markup or scripts changed**: `src/`, `project/tokens.json`, `project/components/`,
`dist/`, `bundle.css` and the compositions are as reviewed. Two tools, the corpus and the text changed.

### The waiver

- **What was waived.** B1 of `review.md`: at 400 px with a coarse pointer a reload often came back at the wrong scroll position, with
  no layout shift (Narrow and zoom, blocker: "reloaded scrolled to each chart … and landing where it was"). It is the "intermittent
  landing miss" this response left open under B1. It is waived, not withdrawn and not fixed.
- **By whom.** The second reviewer, on 26 Nov, who wrote neither the system nor `review.md`. Not the author, and not the first
  reviewer. Only B1 was reviewed again. `review.md` says that with B1 settled by a fix or a recorded waiver v9 can be approved; that
  verdict is the first reviewer's and is not restated here as an approval.
- **On what evidence.** All four are the second reviewer's measurements on this machine (the E numbers are that file's):
  1. *The outgoing document says so itself.* Playwright's `hasTouch` makes the pointer coarse by DevTools touch emulation. Between its
     `beforeunload` and its `pagehide`, the document a reload is replacing reads pointer coarse, height 9,659, scroll 8,859, and then
     pointer **fine**, height 9,124, scroll 8,324. The reload comes back at 8,324: the "535 px short" is the page's coarse height less
     its fine height. 8 of 8 touch-scrolled reloads and 9 of 9 script-scrolled ones (E4).
  2. *The reloaded document plays no part.* Answered with a plain 30,000 px page, the reload is restored to the same wrong offset in
     10 of 12 (E3).
  3. *A page that is not viz does the same.* 24 blocks and one `@media (pointer: coarse)` rule: 8 of 8 with a recorder at `pagehide`,
     7 of 16 without; without the rule, 0 of 8 (E6, image `02`, appendix A).
  4. *With a pointer that stays coarse, the system's pages land where they were.* The pointer made coarse in Blink by a command-line
     switch, no touch emulation, same pages, same coarse layout, same drags: **0 of 204** reloads elsewhere (E7, E10).
- **What this response had wrong about it.** "Cause not found" (it was findable: the outgoing document, which I never looked at). The
  rate, "three in about 330 reloads" (`review.md`, m2: 4 of 29 on a first pass, 22 of 34 after a touch scroll; the second review: from
  0 of 12 to 9 of 9 on one page, depending on what else the outgoing document is doing). "The page does not move under the person; the
  browser restores to the wrong place" was right as far as it went. The spike's "0 of 36 after a synthetic gesture" was void and its
  reading that the fling matters was wrong (`spikes/s12-reload-on-a-phone/README.md`, corrected).
- **What is NOT known.**
  - **No real phone was tested**, by the author, by either reviewer or by anyone. The spike's pages are still up for that test and the
    test has not been run.
  - **The stable coarse pointer is a command-line switch on desktop Chromium standing in for a phone.** It is not a phone. That a
    phone's pointer type does not change during a navigation is the second reviewer's training knowledge, not a measurement.
  - Only Chromium was tried (the headless shell 157.0.8103.78, and full Chromium 153 headless and in a window, by the second
    reviewer). Not Firefox, not WebKit, no other version. Chromium's source was not read; one search found no filed issue.
  - Not explained, by the second reviewer's own list: what decides whether the outgoing document is laid out again before it goes
    (which is what makes the rate vary); why an animation-frame loop in it lowers the rate; why the system's page passes through
    8,638 before settling at 8,324; why the outgoing page's fine-pointer height depends on how it was scrolled.
  - Why the browser marks the layout shifts of the first half second of a load as following input under `isMobile` (below).
- **What reopens B1.** Either of two things:
  1. **A reproduction on a real phone**: the test in `spikes/s12-reload-on-a-phone/README.md`, on the pages that spike has live. A
     reproduction is coming back on different content, hundreds of pixels away. A difference of about the height of the browser's
     address bar at the very end of a page is not one (the second reviewer's note; training knowledge, not measured).
  2. **A reload landing elsewhere here with the pointer coarse and no touch emulation**: the audit's reload pass, as changed below,
     failing on landing. (The second review adds: or someone showing a real device whose pointer type changes as a page navigates.)

### What the second review required of the author, and what was done

| Required | Done | Where |
|---|---|---|
| The audit's reload pass makes its 400 px pointer coarse in Blink, not by touch emulation, with a guard (its recommendation 1, appendix B) | Yes | `tools/audit.mjs`: for the pass's 400 px layout the first browser is closed and one is launched with `--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1`; contexts with `isMobile` and without `hasTouch`; a new finding kind, `pointer`, if `(pointer: coarse)` does not match on the page as opened, on the page served without script, or on the reloaded page. One browser at a time. Every other pass keeps touch emulation |
| The same pass counts every layout-shift entry, marked or not (recommendation 2) | Yes | `tools/audit.mjs`: the jump's and the reload's entries are summed apart, unmarked and marked `hadRecentInput`, printed in two columns each and in the `--json` rows (`jumpShiftMarked`, `reloadShiftMarked`); the pass fails when their **sum** is 0.05 or more, which fails on either alone and also when only the two together reach the budget. A failing reload prints its entries |
| Check `tools/speed.mjs` for the same | Yes: it only recorded them. Changed | Below |
| Keep the text true: how the pass's pointer is made, and why | Yes | `project/README.md` (Responsiveness and feedback), `README.md` (the tools table, review history, "Not done yet"), the header of `tools/audit.mjs` |
| The two changes and T3.audit's survival at 400 px in the mutants' record | Yes | B1, "What guards it now" (corrected in place), "Mutant record" below, `tools/mutants-corpus.mjs` (T3.audit's description; T8.audit and T9.audit added) |
| The spike's README: the synthetic gesture, the fling, this result | Yes | `spikes/s12-reload-on-a-phone/README.md`. The Worker is not deleted: the pages stay up until the owner has run the phone test or decided not to |
| The waiver and its residual uncertainty recorded here and in the pull request | Here: this section. The pull request is the lead's to write | — |

### The reload pass after the change

Measured here, 26 Nov, on the tree: Playwright 1.63.0, `chromium_headless_shell` 157.0.8103.78 (what the audit uses), 4 cores shared
with another session's browser jobs. "Elsewhere" is more than 1 px. Layout shift is judged at any load.

| Run | Reloads | Landed elsewhere, 1500 px | Landed elsewhere, 400 px coarse | Largest shift, unmarked | Largest shift, marked | Findings | Exit | Load |
|---|---|---|---|---|---|---|---|---|
| `node tools/audit.mjs --reload-only`, first | 106 on 9 pages | 0 of 53 | **0 of 53** | 0.0000 | 0.0000 | 0 | 0 | 1.3 to 2.4 |
| the same, second | 106 on 9 pages | 0 of 53 | **0 of 53** | 0.0000 | 0.0000 | 0 | 0 | 2.4 to 1.7 |
| `npm run audit`, the full audit (its reload pass) | 106 on 9 pages | 0 of 53 | **0 of 53** | 0.0000 | 0.0000 | 0 on system pages | 0 | 1.3 to 2.2 |

The largest shift is over the reload and the jump, at both layouts; no chart moved after a jump in any run. `(pointer: coarse)`
matched on every page of the 400 px layout (no `pointer` finding). This reproduces the second reviewer's 0 of 53, exit 0, twice
(their E10). With every entry counted, every sum is exactly 0 in both runs: v9's reloaded documents have no layout-shift entry, marked
or not. One reload in the first run, the claims composition at 1500 px, landed 1 px away, which is within the tolerance; every
other one landed at 0 px.
`evidence/second-review-reload-two-runs.txt`, `second-review-reload-run1.json`, `-run2.json`, `second-review-audit-full.txt`.

**The full audit**, run as the README says (`npm run audit`): 56 pages × 14 configurations, the reduced-motion pass, then the reload
pass; 12.4 min. **System pages: 0 findings; exit 0.** Flow screens (read only, reported apart): 122 findings, the same count and
the same three kinds as in "Final runs" above (`press`, `fold-scroll`, `sentence-link`). The two full audits of v9 before this one
each failed on one landing miss at 400 px coarse; this is the first to pass, and it passes because the pass no longer measures the
emulator, not because a limit was put on a rate.

Three passes over every chart is 159 reloads at 400 px with the pointer coarse and no touch emulation, 0 elsewhere, and 159 at
1500 px, 0 elsewhere. That is the same finding as the second reviewer's 0 of 204, by the same means, and it does not stand in for a
phone.

### Teeth: a shift early in a reload, the shipped pass against the changed one

On a scratch copy, never the tree: the Chart preview, on a reload only, adds a quarter of the window at the top of the page 300 ms
after its script runs and takes it away 150 ms later, scroll anchoring off (the second reviewer's 0.25 shift at 300 ms is the model;
taking it away again means the page ends where it began, so nothing but the layout shift can show it). Each pass run twice with
`--reload-only dist/preview/Chart.html`: every chart, 10 reloads a layout. Measured here.

| Pass | 1500 px | 400 px coarse |
|---|---|---|
| As shipped (touch emulation; unmarked entries only) | 0.1922 on 10 of 10, both runs: 10 findings each | **0.0000 on 10 of 10, both runs: 0 findings in 20 reloads** |
| Changed (coarse in Blink; every entry) | 0.1922 unmarked on 10 of 10, both runs: 10 findings each | **0.0000 unmarked and 0.4400 marked on 10 of 10, both runs: 10 findings each, exit 1** |

So at 400 px the shipped pass read 0.0000 for a shift of 0.44 and passed it; the changed pass fails it on every reload. No reload
landed elsewhere in these 80. `evidence/second-review-teeth-late-shift.txt`.

**How blind the 400 px figures were.** A page that is not viz, 200 px added at its top N ms after its script runs, jumped to 3,000 and
reloaded, two tries each (`evidence/second-review-mark-probe.txt`, with the probe): with `isMobile`, whether the pointer is coarse by
touch emulation or in Blink, the entry is marked `hadRecentInput` at 100, 300 and 450 ms (read at 110 to 462 ms after the reload
began) and unmarked at 600 and 1,000 ms (610 ms on). At 1500 px fine, at 400 px fine, and at 400 px coarse in Blink without
`isMobile`, it is never marked. So under `isMobile` any sum of unmarked entries is blind for about the first half second of a load.
Why the browser marks them was not established.

### `tools/speed.mjs`

**What it did.** It summed unmarked entries into the figure it judged and kept the marked ones in a variable (`shiftAfterInput`) that
it never printed, wrote out or judged. Its phone layout uses `isMobile`, so both of its layout-shift measures were blind for the first
half second of a load, which is where a load's shifts are.

**What the budget requires.** "Layout shift stays under 0.05 at both layouts, including a page that loads already scrolled to a chart."
A shift that follows no input is a layout shift whatever the browser marks, so the marked entries of a load have to be judged. The
exclusion that is right, a shift within 500 ms of the harness's own press or tap, is kept.

**What it does now.**
- `load-shift` (a load opened scrolled to a region, given no input): every entry counts.
- `shift` (the whole run): every unmarked entry, and every marked entry from **before the harness's first input** as the page
  receives it. Marked entries after that are left out, as before.
- Under the table it prints, per row, how much of the judged figure came from marked entries and how much was left out after input;
  both go to `--out` (`markedCounted`, `markedAfterInputLeftOut`).
- The phone layout keeps touch emulation: it needs touch events, and it measures no document across a navigation.

**Teeth**, on a scratch copy whose fixture page adds a quarter of the window at its top 300 ms after its last script runs; the shipped
scenarios with only their layout-shift rows, 3 runs each, CPU 4x, Fast 4G. Measured here:

| Harness | Phone layout, six rows | Desktop layout, two rows |
|---|---|---|
| As shipped | **0.0000 on all six, "within", exit 0** | 0.1566 and 0.1565, over, exit 1 |
| Changed | **0.2500 to 0.2688 on all six, over, exit 1** | 0.1566 and 0.1565, over, exit 1 |

**v9 with the changed harness**, the tree's fixture page (a floor, not the application), the shipped scenarios whole. 5 runs on the
phone and 3 on the desktop, not the 20 the budgets ask for: only the layout-shift rows are reported from them (judged at any load).

| Layout shift, p75 = median = worst | Budget | Phone, 5 runs | Desktop, 3 runs |
|---|---|---|---|
| Load and run | 0.05 | **0.0015**, all of it from marked entries before any input (0.0008 more left out after input) | 0.0004 (none marked before input; 0.0001 left out after) |
| Loaded scrolled to CPU by pod | 0.05 | 0.0000 | 0.0002 |
| Loaded scrolled to Latency by route | 0.05 | 0.0001, marked | — |
| Loaded scrolled to Request rate | 0.05 | 0.0000 | — |
| Loaded scrolled to CPU by pod, every namespace | 0.05 | 0.0000 | — |
| Loaded scrolled to the backtest | 0.05 | **0.0188**, all of it marked | — |

All within the budget. **But the phone column of the Speed section above, "0.0000 everywhere", was partly blind and is not what the
page does**: opened scrolled to the backtest, the fixture shifts 0.0188 in its first half second, in every one of 5 runs. I did not
look for what moves, v8's fixture was not measured this way, and the app's measurements, if they filter the same way, have the same
blind spot.

**A timing row that was over, said plainly.** In the 3-run desktop sample "Change theme (to dark)" came out at 101 ms against 100 (the
p75 of three samples is the largest of them; median 96; load 1.6, judged), so that run exited 1. That row alone, 20 samples with each
harness in alternating blocks of 10, on a clean copy whose `dist/` is byte for byte the tree's:

| Change theme (to dark), desktop, 20 samples | Budget | p75 | Median | Worst | Samples over 100 ms | Load (median, range) | |
|---|---|---|---|---|---|---|---|
| The harness as shipped | 100 | 97 ms | 87 | 129 | 5 | 1.9 (1.1 to 2.4) | judged, within |
| The changed harness | 100 | 89 ms | 82 | 169 | 5 | 1.8 (1.6 to 2.0) | judged, within |

Within, and the harness change does not move it beyond its spread. The margin is thinner than the 81 and 72 ms of the Speed section
and the first reviewer's 82, on a page that is byte for byte the same. I do not know why; another session's timing runs shared the
machine, and the calibration task took 331 to 373 ms (238 to 300 in the Speed section, 330 to 375 for the first reviewer). The
phone's 5-run sample had it at 88 ms. `evidence/second-review-speed.txt`.

### Mutant record

The corpus is now **178**: T8.audit and T9.audit were added for the two changes.

| Mutant | Broken | Killed by | Where it survives |
|---|---|---|---|
| **T3.audit** | Four charts of the Chart preview with no reservation in their markup | **`reserve` only** (the served page's reservation, no script), at both layouts: 6 of 6 runs here, and in the corpus runs | **The reload pass's own measures, layout shift and landing, at both layouts, in some runs.** Changed pass: a reload finding at 400 px in 2 of 4 runs and at 1500 px in 2 of 4. Shipped pass: at 400 px in 0 of 2 runs (its shifts are marked there and were not counted), at 1500 px in 2 of 2. No landing miss in 88 reloads |
| **T8.audit** (new) | On a reload of the Chart preview, a quarter of the window added at the top 300 ms after its script runs and taken away 150 ms later | `reload-shift` at 400 px coarse, by the marked entries (0.4400), and at 1500 px by the unmarked ones (0.1922). It expects the 400 px finding | Run against the audit as shipped, by the corpus runner on a scratch tree: **not as expected**: caught at 1500 px only, no finding at 400 px. That is the survivor the change removes |
| **T9.audit** (new) | The switch that makes the reload pass's 400 px pointer coarse removed from `tools/audit.mjs`, as if Chromium had dropped it | `pointer`: "the pointer is not coarse at this layout" | Nowhere found. Without the guard nothing would fail: the pass would read a fine-pointer layout and call it the phone's |

**Re-run after the change**: the 48 mutants that run `tools/audit.mjs`, each on a fresh copy outside the tree
(`node tools/mutants.mjs <scratch> --only …`, 10.4 min, load 1.6 to 1.1): **48 of 48 as expected, 48 caught, 0 survived** (Y 8, Z 6,
W 8, U 12, Q 4, T 6, A 4). `evidence/second-review-mutants-audit.txt`. `npm test`: 199 tests, **139 pass, 0 fail**, 60 skipped (they need a browser; 48 of them are the 48 above), 65 s. **Not re-run:** the 12 mutants that
need `check.mjs`'s rendered audit, and the corpus as one run; nothing they exercise changed.

A survivor, reported: **T3.audit still survives the reload pass's reloads in about half the runs at either layout.** It is killed
because `reserve` reads the served page, not because a reload shows it.

### Statements above that were false or partly blind

| Where | Statement | What holds |
|---|---|---|
| The findings table, B1; "Over every load" | v9 "0.0000 on every load" at 400 px coarse | Those passes summed unmarked entries only, which under `isMobile` cannot see the first half second. With every entry counted it is still 0.0000, unmarked and marked, on 53 of 53 at 400 px in each run above. The claim holds, and is now measured |
| B1, "Not fixed, open" | "cause not found"; "three in about 330 reloads" | The cause is the measuring tool (second review). The rate under touch emulation is anything from 0 of 12 to 9 of 9 |
| B1, "What guards it now"; "Final runs" | T3.audit "first caught by the reloads, landing 1,178 px away" | Not a catch: the emulator's landing miss. Corrected in place |
| Speed, the phone table | "Layout shift … 0.0000 everywhere" | 0.0015 on load and run and 0.0188 loaded scrolled to the backtest, in marked entries; within 0.05 |
| "How it was checked", `tools/shots.mjs` | The `reload` step's printed shift and its coarse images | The step uses touch emulation and sums unmarked entries: its 400 px coarse shift figures are blind for the first half second, and a coarse capture of a reload can show the emulator's miss (one capture landed 369 px short, which fits it: `evidence/missed-reload-memory-400-coarse-light.png`). Not changed here |

### Final runs after these changes

All measured here on 26 Nov, on the tree as it is now, one job at a time.

| Run | Result | Exit |
|---|---|---|
| `npm run audit` (the full audit) | System pages: 0 findings. Flow screens: 122, as before, reported apart. Reload pass: 0 of 53 elsewhere at each layout, every shift 0.0000 | **0** |
| `node tools/audit.mjs --reload-only`, twice | 0 findings; 0 of 53 elsewhere at each layout; every shift 0.0000, unmarked and marked | **0, 0** |
| `node tools/check.mjs` (with its rendered audit) | 873 of 873 checks; 30 previews in both themes at rest, hover, press and a finger's press, 0 failures; 11 charts reserved = drawn at 1200, 400 and 320 px; 0 literal values | **0** |
| `node tools/check.mjs --no-render project/components reviews/system-v9/compositions` | 759 of 759; 0 literal values in 43 files | **0** |
| `node tools/check.mjs --no-render tools/speed.mjs` | 0 literal values | **0** |
| `node tools/check.mjs --no-render tools/audit.mjs` | 13 literal values, the same 13 as before the change (colours and `0px` the audit sets or compares in order to measure) | 1, as before |
| `node tools/check.mjs --no-render tools/mutants-corpus.mjs` | 33 literal values; 31 before. The corpus is a file of planted violations; the two new ones are T8.audit's `25vh` | 1, as before |
| `npm test` | 199 tests: 139 pass, 0 fail, 60 skipped (need a browser) | **0** |
| `node tools/mutants.mjs <scratch> --only` the 48 that run the audit | 48 of 48 as expected | **0** |
| `node tools/speed.mjs fixtures/speed-phone.json --runs 5` | Every row within, layout shift included (0.0188 at most); 5 runs, so the timing rows are not the budgets' 20 | **0** |
| `node tools/speed.mjs fixtures/speed.json --runs 3` | Layout shift within (0.0004, 0.0002). **"Change theme (to dark)" over: 101 ms as the p75 of 3 samples.** At 20 samples: 89 ms, within (above) | **1** |

The lint is a gate for the component CSS, the previews, the compositions and application code; it is run on the tools here so that
what it says about the changed files is on record. `evidence/second-review-audit-full.txt`, `second-review-check.txt`,
`second-review-npm-test.txt`.

### Not done

- **A real phone.** The one check the first reviewer asked for. The spike's Worker is still deployed for it and was not touched.
- **`tools/shots.mjs`'s `reload` step** still makes its coarse pointer by touch emulation and sums unmarked entries (the second
  review's recommendation 3 covers it). It was not edited: another change was running it during this session. It should get the
  audit's pointer and count before a coarse reload is imaged again.
- **`review.md`'s two minors** (m1: the legend grows 45 px when a refresh makes "Colour the eight largest" appear; m2: the rate) are
  not addressed by this change. m2 is answered by the second review.
- **What moves 0.0188** when the fixture opens scrolled to the backtest on the phone layout: not looked for.
- The full speed scenarios at 20 runs were not re-run; the corpus was not re-run as one run; the reference and the published design
  page were not republished; the waiver is not yet in a pull request (the lead's).
- Not checked, as before: Firefox and WebKit, a screen reader by ear, real touch hardware.

### Files changed in this step

- `tools/audit.mjs` (the reload pass: its pointer, the guard, every entry counted, the table, a count by layout, the header).
- `tools/speed.mjs` (marked entries given no input are judged and reported; the header).
- `tools/mutants-corpus.mjs` (T3.audit's description and note; T8.audit, T9.audit; the header).
- `project/README.md` (Responsiveness and feedback), `README.md` (tools, corpus count, review history, "Not done yet").
- `reviews/system-v9/response.md` (this section; four corrections marked in place; the status line), `evidence/second-review-*`.
- `spikes/s12-reload-on-a-phone/README.md`.
- Not edited: `review.md`, `second-review.md`, `src/`, `project/tokens.json`, `project/components/`, `dist/`, `tools/shots.mjs`,
  `app/`, `reviews/app-v9/`.

### Housekeeping for this step

- Every mutant and every deliberate breakage ran on copies under the session scratchpad (`ds-v9-waiver/`); the tree was never
  mutated. The mutant runner's copies were deleted by the runner.
- One browser job of mine at a time. Another session was running browsers for the app throughout, which is the load printed above;
  its timing runs and mine shared the machine.
- Each tool starts its own local server and closes it; none is left running, and no browser of mine is running.
- Git: read-only commands (`status`, `diff`, `log`, `show` of the two tools as committed, to have the shipped versions). Nothing was
  committed, pushed, stashed or reset. No Cloudflare resource was touched; nothing was deployed or fetched from the spike.
