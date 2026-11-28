# Second review: chart speed, app-v9 blocker B1 at 200 series

Reviewed 2026-11-28 by a second reviewer who wrote neither the change, `PR.md`, nor `reviews/app-v9/review.md`, and
was not given the author's reasoning beyond what `PR.md` says. Scope: whether B1 of the app-v9 review may be waived
for the result's first paint at 200 series. I also checked the evidence that the waiver rests on (the measuring
method, identity, the before and after tables), and I list what `PR.md` must change before merge. Nothing else in the
app-v9 review was reviewed again.

Inputs: `project/review.md` (the rubric), `project/README.md` ("Responsiveness and feedback"),
`reviews/app-v9/review.md` (B1), `reviews/chart-speed/PR.md`, `app.patch`, `tools/ab.cjs`, `tools/summarise.cjs`,
every file in `data/` (the 2026-11-27 folder included), and the trees: `git` at HEAD, c4a154b, 0aa0f7a and cc50ea2,
read only, and the author's scratch builds `b1/before` and `b1/after`, compared but not run.

**Nothing here is a new measurement.** I ran no browser and no timing job. Every figure below was **measured here by
the author** (this shared 4-core machine, Chromium headless shell, CPU 4x, Fast 4G, the development mock). Where I give
a figure the PR does not, I **recomputed it from the raw runs** in `data/*.json` with the script named under "How this
was checked".

## Decision: B1 is waived at 200 series, with conditions

**What is waived.** The Speed row (blocker) for one budget row only: "Receives a result: paint it … 100 ms after it
arrives". It covers Explore, results of more than 36 and up to 200 series, both layouts and both definitions of
"arrives" (body read, last byte), up to the bounds under "What reopens it". It is a waiver, not a withdrawal. The
miss is real. A person on the reference setup gets this paint later than the system allows, and the change that
would meet the budget is a design change to the system's chart that has not been made.

**What is not waived.**

- Anything at 36 series or fewer. B1's 36-series row must be met, and is met in this session (below).
- Chart to table at any size. The phone's 36-series row read **101 ms** in this session (C2).
- The dashboards view, results above 200 series, and the waiting-line change (C4). None of them has been measured
  or reviewed.

**The waiver takes effect when C1 to C4 are done, and lapses on 2026-12-31 unless F1 is decided by then.** Until C1
to C4 are done, B1 stands as the first reviewer wrote it.

## Why, tied to the rubric

- **The row.** Speed: "Are the budgets met at both layouts … and the 36- and 200-series cases measured?", blocker,
  with no "else". README: "a figure measured only on a few series is not a pass". The rubric gives the waiver to a
  second reviewer, "who records why". It sets no test for one, so I state mine. A budget that the reference setup
  really misses may be waived when four things hold:
  1. Nothing false or unstable is shown while the person waits.
  2. The excess is small against what the person is waiting through.
  3. Nothing left that would meet the budget is invisible: every remaining remedy changes what a person sees, and so
     belongs to the system's owner.
  4. Refusing would keep something worse than the change.

  All four hold here, the third only once C1 is done.
- **This is not the precedent's case.** In `system-v9/second-review.md`, the measurement was the tool's own fault, and
  a person never saw the failure. Here the tool's part has been taken out ("The measuring method", below), and what
  remains is real: 110 / 127 ms after the body was read (median / 75th percentile) on the desktop layout at 4x CPU,
  and 136 / 156 ms after the last byte. The waiver accepts a real miss, so it is bounded, given a deadline, and given
  conditions that reopen it.
- **1. Nothing false or unstable is shown.**
  - Layout shift was 0 in all 80 runs at 200 series. I checked `clsRunAll`, which counts every entry, the entries
    the browser marks included. The load shift on the phone was at most 0.0002.
  - The press is answered at once. The previous result stays under "Showing the previous query", and the first
    reviewer found every label true through a wait (Stale data, Pass).
  - The waiting line says "Waiting for the query." until the new result is drawn, which is not false. So the Feedback
    and Stale data rows hold during the extra time.
  - README: "Nothing under 100 ms gets an indicator". The excess is 10 to 56 ms on the desktop and 0 to 18 ms on the
    phone, so a warning or a counter for it would be an element that answers nothing (Purpose). **I do not ask for
    one.**
- **2. The excess is small against the wait.**
  - Releasing Run query to the painted result takes a median of 1.72 s on the desktop and 1.04 s on the phone
    (recomputed: 1,721 and 1,043 ms; before the change 1,757 and 1,058). Most of that is the 3.4 MB answer on Fast 4G.
  - The paint after the last byte is 8 % of that on the desktop and 9 % on the phone.
  - The excess over budget at the 75th percentile is 27 ms (body read) and 56 ms (last byte) on the desktop, and
    1 to 4 ms and 18 ms on the phone.
  - **How often this happens is not known**, because viz is not deployed (`PR.md`). That is why R3 exists.
- **3. Nothing invisible is left, apart from C1.**
  - The profile after the change (`data/prof-after-desktop.txt`) puts about 45 % of the remaining time in the plot's
    SVG markup and the browser's work on it, 16 % in layout and 14 % in the model.
  - The candidates that remain all change what a person sees: canvas or a worker (pixels, and the plot's structure
    for assistive technology), a two-step paint (a frame without the band), and coarse data first (the chart fills
    in). The budget row itself names the last one ("coarse data first, refined in place"), so the system already
    allows it. Which of them to take is the owner's call (F1), not a reviewer's and not this change's.
  - The invisible remedies that `PR.md` names are each 5 to 20 ms (the legend's layout, the harness's copy), and they
    do not reach the desktop's 27 ms. I agree with the author's estimate.
  - **One possibly invisible candidate is not ruled out** (C1): "before" reads about 50 ms slower here than on two
    earlier sessions on earlier commits, and nobody has looked into why.
- **4. Refusing keeps something worse.** The change is quicker at 200 series and renders the same:
  - Desktop: −59 ms body read (17 of 18 pairs quicker) and −61 ms last byte (19 of 20).
  - Phone: −20 ms (12 of 15) and −15 ms (15 of 20).
  - At 36 series it brings the desktop inside the budget (113 to 80 ms body read, 127 to 90 last byte).
  - Identity is shown below.

  Refusing the waiver would not get anyone a quicker chart. It would hold back this change and keep B1 open against
  a 27 ms miss on a result that the chart folds to eight colours and an "Other" band.

## 1. The measuring method

**Should the budget count the harness's own work? No.** The budget is about what a person's browser does. A browser
without DevTools attached does not keep its own copy of the response body, and does not decode one on the main thread
when the load ends. Charging that work to the page measures the tool, which is the failure the precedent waived. The
system's own definition of "arrives" in `tools/speed.mjs` (its copy of the body has been read) is the "body read" row,
and that row turns out not to be touched by the change (below).

**Is the evidence sufficient? Yes for what it claims.** I checked `data/method.json` run by run. It is one build (the
build before the change), the two methods alternated ABBA, 20 runs each, and every run had a load at or below 4.

| Check | Recomputed from `method.json` | Holds? |
|---|---|---|
| The flag works | `bodyCopies`: both sessions held the body in 40 of 40 runs with buffers, and neither did in 40 of 40 without. In `ab-desktop.json`, `ab-phone.json` and `clone.json`, neither did in all 340 runs | Yes |
| Network shaping is unchanged | Release to paint at 4 series: 525 against 527 ms median, paired −1 ms, 11 of 20 | Yes. Turning off the buffers did not turn off Fast 4G |
| Small results agree | 4 series, paired: body read +0 (9 of 20 quicker), last byte −2 (11 of 20) | Yes, within noise. The 75th percentiles without buffers are 7 to 10 ms *higher* in all three rows, chart to table included, which has no network in it. So about 10 ms is the noise between two 20-run blocks of one build here |
| It removes only DevTools' work after the last byte | 200 series: last byte −74 ms paired (19 of 20), and release to paint −102 ms (16 of 20). Body read +5 ms (7 of 16) and chart to table −7 ms (10 of 20) are unchanged | Yes. The cost sits between the last byte and the harness's copy resolving, and nowhere else measured. The 74 ms agrees with the ~70 ms the 2026-11-27 trace showed, which was measured independently |
| No trace of a run without buffers | — | Not done. It would show that no other task moved. I do not need it for the decision |

**What follows for the waiver.** The body-read row, the system's own definition, never carried the DevTools cost. So
the 200-series failure by that row does not depend on the method change at all. The change matters only for the
last-byte row, and there it removes about 74 ms that no person's browser spends.

**The harness's own copy of the body** (`clone.json`, 10 runs, 200 series, before build only). Last byte was −19 ms
without the copy (8 of 10 quicker). The evidence is weak:

- Chart to table, which the copy cannot touch, read +8 ms (2 of 10) in the same runs.
- Release to paint shows an order effect of ±35 ms: the build taken second in a pair was 35 ms slower, and the one
  taken first 36 ms quicker.

So "10 to 20 ms" is plausible and not established. It does not matter for the decision: it lowers the last-byte figure
on the desktop by at most 20 ms (156 to about 136 ms), which is still over the budget. The PR's own options, measuring
the two rows in separate runs or accepting the copy and saying so, are both fine. The second is what the PR does now.

## 2. Identity

**Convincing.** I recomputed it from `data/identity-full-raster.json` and `data/identity.json`:

- **Same states, same fields.** Both files hold the same 102 states for each build. Chart markup, accessible names,
  legend row hashes, text forms, tables, chart counts and row counts are equal in every state.
- **The checks have content.** There are 45 distinct chart-markup hashes, 102 distinct images, 214 charts and 2,236
  legend rows. The table hash is filled in the 12 table states and is the empty hash elsewhere, as it should be. Every
  light image differs from its dark one.
- **Pixels.** With whole-layer raster, every state has an image that both builds produced bit for bit. One state of
  the before build had two different images in its two captures, and one of them is the after build's image. Under
  the default raster, `identity.json` has 4 states whose first images differ and 1 with no shared image. This is the
  partial-raster noise the PR describes: `identity-4-*.txt` shows it going from 8 and 6 of 14 states under partial
  raster to 0 of 14 under whole-layer raster, within one build as between builds.
- **The measured build is the one in the PR.** `b1/after/app/src` equals HEAD's `app/src` with `app.patch` applied.
  I applied the patch to a copy in my scratchpad and diffed: no difference. `b1/after` and the tree have the same
  Chart preview and `dist/viz-chart.js`. `b1/before` equals c4a154b. The after build's `dist/` (09:08:50 UTC) is
  newer than every source file in it except a test file.

**What identity does not cover.**

- The waiting states. Every state is a settled result, so the waiting-line change (C4) is outside it.
- The app's dashboards view. It keeps the chart's first form, which the system's fixture pages in the identity set
  also use.
- `model-equivalence.test.mjs` covers the typed form against the first one over 600 random results, gaps included.

## 3. The numbers

I recomputed every cell of the PR's tables from `ab-desktop.json` and `ab-phone.json`. **They match, to rounding.**

- **Order and pairs.** The order is ABBA in every case: in pair *i*, the build taken first alternates. I split the
  paired differences by which build went first. The large effects keep their sign either way: desktop 200, last byte
  −57 and −74 ms; phone 200, −15 and −24 ms.
- **Load.** It was at most 2.8 on the desktop and 1.6 on the phone, against 4 cores, so every row is judged. These
  sessions were quieter than the first reviewer's runs whose result swung (load 2 to 3).

**Rows within a tenth of the limit, or over it.** The rubric has no thin-margin rule. B1's own requirement does:
"a complete before and after run of the final build … on a machine quiet enough that two runs agree". Only one run per
layout was made, so B1's requirement is not yet met for any row (C2). Two blocks of 20 runs of one build differed here
by about 10 ms at the 75th percentile at 4 series. At 200 series, rows that the change under test could not touch
differed by about 20 ms (chart to table in `method.json`, 98 against 77; in `clone.json`, 75 against 98). So a 75th
percentile within about 10 ms of 100 cannot be called from one session.

| Row, "after" | p75, ms | Runs over 100 | Reading |
|---|---|---|---|
| Phone, 36 series, chart to table | **101** | 6 of 20 | **Over**, by the Speed row's own measure. It was 113 before (paired −9, 11 of 20): not caused by this change, and not covered by this waiver (C2) |
| Phone, 200 series, body read | **101** | 5 of 17 | Over, and the figure flatters: the 3 runs with no body-read figure are among the slowest by last byte (ranks 14, 15 and 19 of 20). Filled in from each one's last byte less the median gap, the 75th percentile is 101 to 104 ms. Waived |
| Desktop, 36 series, last byte | 90 | 4 of 20 (worst 122) | Too close to call. It needs a second session, and the waiver depends on it |
| Desktop, 200 series, chart to table | 94 | 3 of 20 | Too close to call (C2) |
| Phone, 200 series, chart to table | 90 | 1 of 20 | Too close to call (C2) |

The missing body-read figures elsewhere do not bias the result. On desktop 200 after, the 2 missing runs rank 3 and 12
of 20 by last byte, and filling them in leaves 126 ms.

**Rows inside by 20 % or more** are accepted from this one session: desktop 36 body read (80 ms), desktop 12
(71 and 80), phone 12 and 36 result paint (64 to 78), and all of 4 series. Desktop 12 has 4 of 20 runs over 100 ms
from the last byte and still a 75th percentile of 80. The phone at 4 series reads +1 and +4 ms after the change, with
8 of 20 pairs quicker, 35 ms inside the budget: noise as far as one session shows, and the second session will tell.

**The 36-series case, on which the waiver's line rests, is met in this session:**

- Desktop: 80 ms body read, 90 ms last byte.
- Phone: 70 ms and 78 ms.

Desktop last byte is the thin one (C2).

**Something the PR names but leaves alone: "before" got slower.** The same budget row read 190 ms for the 200-series
desktop "before" (c4a154b) in this session, against the following earlier sessions:

| Session | Commit | Body read, ms | Last byte, ms | Note |
|---|---|---|---|---|
| First reviewer | cc50ea2 | 143 | 237 | `review.md` |
| The author, 2026-11-27 | 0aa0f7a | 135 | 223 | `data/2026-11-27/ab-desktop.json`; the load was over 4 in 14 of its 40 runs |
| Method check, this session, with buffers | c4a154b | 168 | 286 | |

The body-read row does not depend on the buffers, so the method does not explain this. The commits since include
`7469d5a` (the dashboards) and `aa120dc`, "app: fixes for the second design review, paused before verification (not
green)". That commit adds per-draw work to the chart's fix-ups (`charts/Chart.tsx`) and more to `ExplorePage.tsx`.

The difference spans sessions, so by the project's rules it is not established. The phone shows no clear shift (93,
then 106), and the 36-series desktop figures do not line up (109, then 89, then 113). But at 200 series on the desktop
it is about 50 ms. That is larger than the 27 ms excess the waiver accepts, and if it is real it is very likely
invisible to remove. That is C1.

## Conditions

**Before the waiver takes effect, and before this change merges.**

- **C1. Rule the regression in or out.**
  - Run `tools/ab.cjs` alternating cc50ea2's `app/` (the reviewed build) against c4a154b's, at 200 series, desktop,
    20 runs, in one session.
  - If c4a154b is slower beyond the noise (a paired median outside ±10 ms, with 5 or fewer of 20 pairs quicker), find
    the cause. Remove it if that changes nothing a person sees, and measure the final build again. The waiver does not
    cover time added since the review that can be taken out invisibly.
  - If it is not slower, say so in `PR.md`. Whichever it is, record the run.
- **C2. A second session of the final build, before against after, alternating, at both layouts**, as B1 requires
  ("two runs agree"). At least 36 and 200 series; 4 series as well, for the phone's +4 ms.
  - The rows in the thin-margin table above are called passes or failures only from the two sessions together.
  - **If the phone's 36-series chart to table, or any 36-series result paint, reads over 100 ms at the 75th percentile
    again, B1 is not resolved.** This waiver does not extend to it. It needs a fix, or a second reviewer of its own.
    Chart to table is a local change, and "No waiting state is allowed" there.
- **C3. `PR.md` and the pull request say what is true** (see "What `PR.md` must change").
- **C4. The waiting-line change is shown and reviewed.**
  - `explore/waiting.tsx` removes the line in the render that shows the result, so it is gone one frame sooner. That
    is a change a person sees (AGENTS.md, Design changes). It moves towards the README ("it never covers data"), and I
    expect it to pass, but I have not seen it.
  - Needed: a frame-by-frame record at both layouts of a wait over 400 ms ending in a 36- or 200-series result, before
    and after, and a check that a line shown at 400 ms still stays its 300 ms when the answer comes at 450 ms. Then a
    verdict from a reviewer who did not write it.
  - For that reviewer: the new code calls `setShown` during render and reads `performance.now()` and a ref there. It
    is allowed, but it is not pure, and the app renders under `StrictMode`.

**Follow-ups, with a deadline. The waiver lapses on 2026-12-31 if F1 is not decided by then.**

- **F1. The system's owner decides how a many-series result meets the budget**, and records it in
  `design/DECISIONS.md` with alternatives and "would change if". The choices: coarse data first and refined in place
  (which the budget row already allows), a two-step paint, canvas or a worker, or a budget for many-series results
  written into `project/README.md` with its reason. Changing the budget is the owner's choice and not a reviewer's;
  this waiver is not a change to it.
- **F2. Measure above 200 series.** The API admits far larger results: `maxStepPoints` of 1 M allows about 1,380
  series at 721 points, and `maxSeries` is 20,000 (`query/CARDINALITY.md`). Measure Explore at about 1,000 series at
  both layouts. This waiver does not cover them. If the paint after arrival there passes 400 ms, the waiting table
  applies to that time and F1 must cover it.
- **F3. Measure the dashboards view** at 36 and 200 series, as it is and with `typed: true`, before and after.
  This waiver does not cover dashboards.
- **F4.** `design-system/tools/speed.mjs` keeps the DevTools buffers (line 118). Its budget figure ("arrives" is its
  own copy read) is not affected by them, by `method.json`. Its waits and any figure from the last byte are affected.
  The system's owner applies the same change, or says why not. This is not a condition of this waiver.

## What reopens it

- **R1. A regression at 200 series.** Any judged, alternating 20-run measurement of Explore at 200 series above
  the following 75th percentiles reopens B1:

  | Layout | Body read | Last byte |
  |---|---|---|
  | Desktop | 140 ms | 170 ms |
  | Phone | 115 ms | 130 ms |

  These are this session's figures plus the noise between two blocks of 20 runs here.
- **R2. Any 36-series result paint over 100 ms at the 75th percentile** in a judged session. That row was never
  waived.
- **R3. Usage.** Once viz is deployed and can count the series in an Explore result (a count only, never the query
  text), B1 reopens if more than 1 in 20 Explore results has more than 100 series. The "how often" argument above is
  a guess until then.
- **R4. A real device.** B1 reopens if a mid-range phone, the device the reference setup stands in for, paints a
  200-series result more than 200 ms after the last byte at the 75th percentile.
- **R5. The deadline.** F1 is not decided by 2026-12-31.
- **R6. Something false appears during the extra time.** If anything shown while the result is drawn stops being
  true (the waiting line, the head, the previous result's labels), that is a Feedback or Stale data blocker in its own
  right, and B1 reopens with it.

## What `PR.md` must change before merge

1. **"Where it stands", point 4, and the waiver request's "Everything else in B1 is met in this session".** Say plainly
   that the phone's 36-series chart to table read 101 ms (6 of 20 runs over 100) in this session: a Speed failure by
   the rubric's measure, not caused by this change, not covered by this waiver, and to be measured again (C2). The
   budget table already prints it. The text must not say otherwise.
2. **The phone's 200-series body read (101 ms) is from 17 runs**, and the 3 without the figure are among the slowest.
   Say so, with the filled-in range (101 to 104 ms). Drop "The medians on the phone … are inside", or mark it as
   context: the budget is the 75th percentile.
3. **The noise between blocks of 20 runs.** Give the figures from your own files (about 10 ms at 4 series in
   `method.json`, and about 20 ms in rows that could not change at 200 series) as the reason rows within a tenth need
   a second session.
4. **The "before" figures.** Replace "the cause was not looked into" with C1's result.
5. **The waiver.**
   - Record this decision, its scope, the conditions and what reopens it in `PR.md`, in the pull request description
     and in `reviews/app-v9/response.md`.
   - Add a known risk to `app/README.md`: the first paint at 200 series is over budget under a waiver, until F1 is
     decided or 2026-12-31.
6. **"Checks run".** Run the app's e2e suites (`app.cjs`, `errors.cjs`, `dashboards.cjs`, `prod.cjs`) green on the
   patched tree before merge. The parser now places series while the body downloads, and the error and partial-answer
   paths go through it. AGENTS.md also says that a pull request takes a directory only from a state reported green.
   The "before" commit `aa120dc` is marked "not green", and the shared tree already carries `app.patch` uncommitted.

## Residual uncertainty

- **How often a person meets a 200-series result is not known.** It rests on the start state's examples (1 to 12
  series) and on how PromQL is used, which is training knowledge. R3 settles it once viz is deployed.
- **Whether the "before" build regressed** (C1). Until C1 is run, the claim that nothing invisible is left is not
  established.
- **One session per layout for "after".** The thin rows and the phone's 36-series chart to table are not settled
  (C2).
- **The reference setup is emulated** (CPU 4x and Fast 4G in Chromium on a shared machine). No real phone was used,
  and no other engine.
- **The harness's own copy of the body** still sits in the last-byte row. It is 10 to 20 ms on 10 runs with a large
  order effect, so it is an overstatement of uncertain size, in both builds.
- **Not measured at all:** above 200 series, the dashboards view, the waiting-line frames, and a trace of a run
  without buffers.
- **I ran nothing in a browser.** Every judgement of timing above is the author's measurement, recomputed from the
  raw runs, and every judgement of identity is the author's hashes, recompared.

## How this was checked

The script is
`/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad/b1-second/an.py`, run with
`python3 -I an.py <file.json> …` from `data/`. For each case and build it prints:

- the run order, the load, and the `bodyCopies` counts;
- the median, the 75th percentile, the worst run and the count of runs over 100 ms, with the same quantile rule as
  `ab.cjs` (`ceil(f·n) − 1`);
- the paired differences, also split by which build ran first.

Short inline checks did three more things:

- located the runs with no body-read figure, and filled them in from their last byte;
- summed the layout-shift fields;
- compared the identity records field by field.

The build check put HEAD's `app/src` (`git archive`) in `b1-second/verify`, applied `app.patch` there, and diffed it
against `b1/after/app/src`. c4a154b went in `b1-second/verify-before` and was diffed against `b1/before`. I also read
`git diff 0aa0f7a c4a154b -- app/src`, along with `app.patch` and the files above.

## Housekeeping

- **The tree.** This file is the only one written. Nothing was edited, committed or pushed, and git was used read only
  (`log`, `diff`, `status`, `archive`, `merge-base`).
- **Scratch.** Everything else is under
  `/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad/b1-second/`: the script and two
  source copies.
- **Nothing was run.** No browser, server or timing job, and no Cloudflare call.
