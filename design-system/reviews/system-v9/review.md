# Review: viz design system, v9

Reviewed 2026-11-26 against `project/review.md` as it now reads (v9's, with the lead's D73), by the
reviewer of v5 to v8. Inputs: the system on disk (commit "design-system v9: every chart reserves its
height…"), copied to the session scratchpad, built, served and rendered there; the compositions in
`compositions/`; my own earlier findings, mutants and compositions. `response.md` was used to find what
changed; every claim below was checked here. The image cited is in `review-images/` and was rendered here.

## Verdict: reject, on one blocker that v9 did not cause

v8's B1 is fixed: every chart on every page reserves exactly what it draws, and no reload moves the page.
m1 and m2 are fixed; m3 is resolved as the lead decided. Every timing row I ran is within budget at a
judged load. There are no majors.

One blocker stays, and it is the author's open problem, measured more often here than the author
measured it:

- **B1. At 400 px with a coarse pointer, a reload often comes back at the wrong scroll position, with no
  layout shift** (Narrow and zoom, as v9's rubric now words it: "reloaded scrolled to each chart … and
  landing where it was"; blocker). The author found it in 3 of about 330 reloads. Here:
  - in 10 of 12 reloads after touch-scrolling to the end of the Chart preview, as a person does it. Those
    reloads came back 535 px short (image `01`). Over all such runs it happened in 22 of 34;
  - after a programmatic jump (the audit's method): 4 of 22 reference charts, landing up to 7,620 px
    away; the Chart preview's last chart in 6 of 20.

  It is not v9's doing. The v7 copy does the same (5 of 16), and so does the Chart preview with its
  scripts removed, with off-screen skipping off, or with scroll anchoring off. A plain long page does
  not, nor the same markup unstyled, nor any page at a fine pointer or at 720 or 1500 px. I could not
  find the cause either.

  The rubric gives a blocker no exception for being old. Under it, this is a failure of a blocker row on
  the system's own pages, at a rate a person would meet. It can be fixed, or waived by a second
  reviewer. My advice is to check on a real phone first. If a phone does it, this is a defect to find
  and fix. If not, it is most likely headless Chromium's touch emulation, and a waiver that says so is
  justified. Either way, the audit's reload pass will keep failing on it at random until then. A check
  that fails at random is not a gate.

With B1 settled, by a fix or by a waiver that records why, v9 can be approved. The minors are at the
author's discretion.

## How this was checked

- **Build:** a copy of `design-system/`. `npm run build` there reproduces `dist/` and `bundle.css` byte for
  byte. `chart-rules.test.mjs`: 21 of 21 pass. `check.mjs --no-render`: 759 of 759 checks pass.
- **Reservations:** every chart's reserved height against its drawn height, with skipping switched off
  to read the drawn size. Seven pages (Chart, Panel, fixture, dashboard, charts, monitor, reference) at
  1500 px, 400 px coarse and 320 px coarse.
- **Reloads** (each in a fresh browser context, fonts loaded, then reloaded and read 1.8 s later; "in
  place" means within 1 px):
  - every chart of the Chart preview, the reference, the fixture and three compositions, at 400 px
    coarse, 720 px and 1500 px;
  - repeats and controls at 400 px coarse: skipping off; touch without mobile emulation; a fine pointer;
    a 3 s wait; scroll anchoring off; the v7 copy; a plain long page; the Chart preview saved after its
    scripts ran, with the scripts removed, then with parts of its stylesheet removed;
  - a person's way of scrolling (CDP touch drags with fling) before the reload;
  - a manual restore (`history.scrollRestoration = 'manual'`, `scrollTo` at DOMContentLoaded);
  - a frame-by-frame trace of misses, with every focus and scroll call in the page logged.
- **Colour rules:** in node, through `chartModel`, `recolour` and `legendActions`. The offer at load,
  after the node-b narrowing, widened back, and after pressing. My property check, rewritten for D73
  (the offer is shown exactly when one of the eight largest on screen is grey, and pressing it does not
  throw): 3 seeds, 1,500 sequences, 37,500 steps.
- **Mutants**, on copies: my four v8 survivors (V2b, V3, V4, V10), and two new ones against v9's
  additions. N9: a chart's markup reservation a row short, which the script corrects once it draws. N11:
  skipping undone with a coarse pointer only.
- **A refresh that makes the offer appear,** with no input, on the Chart preview, against the v8 copy.
- **Composed screens:**
  - twelve pages at 400 px coarse: hit areas (493 controls), overflow, smallest text;
  - keyboard walks in both themes on four pages;
  - an overflow sweep of 56 pages × 12 configurations.
- **Speed:** `tools/speed.mjs` on the fixture, CPU 4x, Fast 4G. The theme rows at 20 runs on each
  layout, twice on the phone; the touch crosshair at 20 runs, twice; the whole phone scenario at 10 runs.
- **Machine:** 4 cores shared; 1-minute load 1.3 to 9.5 during the session; each timing carries its load.

Not checked: a real phone (the decisive check for B1), Safari and Firefox, a screen reader by ear; the
author's 176-mutant corpus as one run; the full 14-configuration audit.

## Images

| File | Shows |
|---|---|
| `01-touch-scroll-to-the-end-reload-lands-535px-short-no-shift-chart-preview-400-coarse.png` | The Chart preview at 400 px coarse, light. Left pair: touch-scrolled to the end (8,859), then reloaded: back at 8,324, on the backtest panel instead of the error panel, with a layout shift of 0.0000. Right pair: the same steps, back in place (B1) |

## My v8 findings, checked

| v8 | Now | Evidence | Guarded? |
|---|---|---|---|
| **B1** reloading scrolled to a chart moved the page (0.18 to 1.69) | **Fixed** (the landing miss is the new B1, separate) | Every chart on seven pages reserves exactly what it draws, at 1500, 400 coarse and 320 coarse (charts: 10 on the Chart preview, 22 on the reference, 4 on the charts composition, 7 on the dashboard composition, 6 on the fixture). Reloads at every chart: 0.0000 layout shift in all 265 of mine. At 720 and 1500 px every one lands in place (the Chart preview, the reference, the fixture and three compositions). | **Yes.** My N9 (one markup reservation a row short, corrected by the script once it draws) is caught by the audit's `reserve` ("reserves 465.5 px in the page as served, before any script, and draws 490.5 px"). The author's T1–T3 cover the rest. |
| **m1** four mutants passed every check | **Fixed** | V2b, V3 and V4 are now caught by `check.mjs` without render; V10 by the audit's focus guard ("its ring is drawn inside it and lies 2 px over its letters"). My new N11 (skipping off with a coarse pointer only) is caught by `check.mjs`. | Yes |
| **m2** touch crosshair at its budget, no margin | **Fixed** | Judged, 20 runs: p75 **45 ms** (median 42, worst 50; load 1.3 to 2.0). In the 10-run phone scenario: 43 (load 1.9 to 2.6). Not judged: 47 at a load of 4.2. | — |
| **m3** "Colour the eight largest" offered with nothing to do | **Resolved by D73** | At load: `['more']`, and pressing it would change no slot. Narrowed to node-b: `['more']`. Widened back: `['more','recolour']`, with "14 in Other are now larger than a coloured series". After pressing: the eight largest coloured, `['more']`, "8 coloured by size; 28 in Other". My property check under the D73 wording found no violation in 37,500 steps. | P8 in the author's tests; C16 |

**A correction to my v8 review.** In v8's B1 table I listed the v7 copy as "0.0000, in place" on reload.
That rested on one reload per chart. The v7 copy also lands elsewhere at 400 px coarse (5 of 16 and 2 of 16
here). What I measured then, and what v9 fixed, was the layout shift. The landing miss was there all
along.

## Blocker

### B1. A reload at 400 px coarse often lands somewhere else, without any shift

Rubric: Narrow and zoom (blocker), as v9 words it: "layout shift under 0.05 when the page loads scrolled
to a region (reloaded scrolled to each chart, as `tools/audit.mjs` does, and landing where it was)".
README, Responsiveness: "a page that loads already scrolled to a chart (as a reload does)". Image `01`.

**Measured here** (layout shift was 0.0000 in every one of these):

| Case, 400 px coarse unless said | Came back elsewhere | How far |
|---|---|---|
| Every chart, programmatic jump then reload: Chart preview / reference / charts composition / dashboard composition / fixture / monitor | 2 of 10 / 4 of 22 / 1 of 4 / 1 of 7 / 0 of 7 / 0 of 1 | 369 and 1,439 / up to 7,620 / 663 / 18 px |
| Chart preview and charts composition, again (28 reloads) | 2 | up to 663 px |
| the same, skipping (`content-visibility`) off | 2 of 28 | up to 2,140 px |
| the same, touch without mobile emulation | 2 of 28 | up to 1,439 px |
| the same at 400 px **fine**; and every chart at **720** and **1500** px | **0 of 28; 0 of 102** | — |
| Chart preview, last chart: 20 tries; 3 s wait before reloading; scroll anchoring off | 6 of 20; 4 of 16; 2 of 20 | 1,439 px (always to 7,420) |
| **v7 copy**, Chart preview, two charts | 5 of 16, 2 of 16 | — |
| Chart preview saved after its scripts ran, **scripts removed** | 10 of 16 | — |
| the same, **stylesheet removed** | **0 of 16** | — |
| the same, first half of the stylesheet removed / second half removed / any single rule removed | 0 of 12 / 12 of 12 / still misses | — (no single rule found) |
| A plain long page (16 blocks, no system CSS) | 0 of 32 | — |
| **Touch-scrolled as a person does**, then reloaded: Chart preview | **22 of 34** (10 of 12, 5 of 8, 5 of 10, 2 of 4) | 535 px short, from the end |
| the same, with a manual restore at DOMContentLoaded | 10 of 10 | 535 px short |
| the same, plain page / unstyled snapshot | 0 of 8 / 0 of 8 | — |

**What the trace shows** (Chart preview, last chart, a miss): at DOMContentLoaded the page is already at
its full height (9,659 px) with scroll 8,638 instead of 8,859. About 90 ms later, after `load`, the
browser scrolls it to 7,420. The viewport is 400 × 800 at scale 1 throughout. No script in the page calls
`focus`, `scrollIntoView` or `scrollTo`. The restored positions repeat exactly (7,420; 8,324; 8,638),
which suggests the browser clamps to an extent the page had at some moment during load. I did not find
that moment.

**Judgement under the rubric.**
- It is a defect of the system's pages. The plain page and the same markup without the system's stylesheet
  do not do it. The system's pages do, whether or not their scripts run.
- It is not v9's regression. v7 does it, and v9's reservations and off-screen skipping are not involved.
- It is not B1 as v8 had it. Nothing moves under the person: the browser restores them to a place they
  never were.
- It is a failure of a blocker row as now written, at a rate a person would meet after a touch scroll.
  Under the rubric that means reject unless fixed or waived by a second reviewer.

**What to do.**
1. Reproduce on a real phone (Chrome on Android; Safari on iOS): touch-scroll the Chart preview to the
   end and reload, about 20 times. If it reproduces, it is a real defect: keep bisecting the stylesheet
   (cumulative, not one rule; it went away only with whole halves removed). Look first at what is laid
   out differently at a coarse pointer.
2. If it does not reproduce on a phone, let a second reviewer waive it as headless Chromium's emulation,
   recording that.
3. Either way, decide what the audit's reload pass does at 400 px coarse. Today it fails at random (the
   author's full audit failed on it once in its last run, here it misses in roughly one reload in seven
   after a jump). A gate that fails at random gets ignored. Make it run the reload several times and report
   a rate against a stated limit, or exclude what is shown to be the emulator.

## Minors

- **m1. When a result makes "Colour the eight largest" appear, what is under the chart moves 45 px**
  (Responsiveness: "every region reserves its final size before its data arrives"; within the layout-shift
  budget, by 0.001 at worst).
  - v9 gives each action its own row and offers the recolour only when it would change a colour (D73). So
    a refresh that makes a pod larger than a coloured one adds a legend row.
  - On the Chart preview, with no input, as a refresh: the chart grows from 820 to 865 px at 400 px coarse
    (559 to 584 at 1500), and the next panel moves 45 px (25 px).
  - Layout shift per event: 0.0202, 0.0326, 0.0450 and **0.0487**, as the end of the chart sits at 500,
    300, 100 and 40 px down the viewport. At 1500 px: 0.0044.
  - The v8 copy, which always showed both buttons on one row: 0.0000.
  - A dashboard refreshing every 30 s can do this on every refresh that crosses the line. The fix is the
    lead's choice: keep the recolour's row reserved while Other has members (drawn empty when not
    offered), or say the offer in the note's line.
- **m2. The author's rate for the landing miss is too low to plan on.** About 1 in 110 there; here 4 of 29
  on the first pass of every chart at 400 px coarse, and 22 of 34 after a touch scroll to the end. The
  difference is the method (a jump against a scroll by finger, and where on the page). Any later
  measurement should use both.

## Timings

Measured here with `tools/speed.mjs` on the fixture page (a floor, not the application), CPU 4x, Fast 4G,
4 cores; calibration 330 to 375 ms (context only):

| Row | Layout | Runs | p75 | Median | Worst | Load (median, range) | |
|---|---|---|---|---|---|---|---|
| Change theme (to dark) | phone | 20 | **71 ms** | 60 | 124 | 3.7 (3.2 to 3.8) | judged, within |
| the same | phone | 20 | **79 ms** | 67 | 121 | 2.2 (2.0 to 2.5) | judged, within |
| the same, in the whole phone scenario | phone | 10 | **78 ms** | 68 | 88 | 2.3 (2.0 to 2.5) | judged, within |
| Change theme (to dark) | desktop | 20 | **82 ms** | 74 | 156 | 3.8 (3.4 to 4.2) | judged, within |
| Transitions running when the theme change is drawn | both | 20 + 20 + 10 + 20 | 0 | 0 | 0 | any | judged, within |
| Crosshair by touch drag, 36 series | phone | 20 | **45 ms** | 42 | 50 | 1.9 (1.3 to 2.0) | judged, within |
| the same | phone | 20 | 47 | 43 | 54 | 4.2 (3.8 to 4.5) | not judged |
| Whole phone scenario, every other row | phone | 10 | all within | — | — | 2.2 to 2.3 | judged |

**The theme change is within its budget.** The budget is the 75th percentile. My judged figures are 71,
78 and 79 ms on the phone and 82 ms on the desktop, against the author's 99 ms (a 10-run p75 at a load
of 3.6). Single samples above 100 ms occur on both layouts (worst 121 to 156 ms), as in v8; the budget
does not count those. In the whole phone scenario at 10 runs (load 2.2), every row is within its budget
and every layout-shift row is 0.0000.

## Composed screens

No regression found:
- 0 px page overflow in 672 loads. The flow screens 1, 8 and 12 still scroll their folding tables at
  768 px coarse, 1024 px and 200% zoom, as before.
- 493 controls at 400 px coarse on twelve pages: none under 44 px (the one listed, "node-b overview", is
  a link inside a sentence), no overlap. The secret composition's controls behind its dialog are
  correctly unreachable, as in v8.
- Every keyboard stop ringed in both themes: my list 117 stops, Chart preview 81, dashboard 65, folded
  list 96.
- The legend's actions on separate rows at 320 px coarse fit without wrapping (`compare/v9-b1-legend-two-actions-*`).

## The author's claims, checked

**Did not hold, or held only in part:**

| Claim | What I found |
|---|---|
| The landing miss: "three in about 330 reloads" | Far more often here: 4 of 29 on a first pass of every chart, 22 of 34 after a touch scroll to the end (B1, m2). The author's cases ruled out also hold here: same page height, no shift, not skipping, not the fonts. |
| v8 copy at 400 px coarse in the response's table: "0.0000, in place" for the narrowed panel | Not re-run on v8. On v7, single reloads can land in place by chance, as mine did in v8 (see the correction above). |

**Held, checked here:**
- every chart reserving exactly (seven pages, three layouts);
- 0.0000 layout shift on every reload;
- 720 and 1500 px landing in place;
- the four v8 survivors now caught;
- the crosshair's margin;
- the theme change within budget;
- D73 as built and tested;
- the build, the chart tests, the static check;
- overflow, hit areas and rings.

**Not checked:** the 176-mutant corpus as one run; the full audit; the crosshair profile; the claim that
`hidden` now hides (seen only as the fixture's shorter page).

## Housekeeping

Everything ran on copies in the session scratchpad. That includes the probe pages written into the copy:
a plain page, and snapshots of the Chart preview with scripts or styles removed. The tree was not edited,
except this file and `review-images/` (1 image, 0.14 MB).

Servers: one static server on the v9 copy (port 8981). Briefly, one on the v7 copy and one on the v8
copy (8962). Also the speed harness's and the audit's own servers. All are stopped. One probe hung with
JavaScript disabled; I stopped it and did not use it.

Git: two read-only commands (`git log -3` and `git status --short design-system`) ran early, to find the
commit. Nothing else.

No Cloudflare resource was touched.
