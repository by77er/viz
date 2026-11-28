# Third review: app-v9 blocker B1 after C1 and C2

Reviewed 2026-11-28 by a reviewer who wrote none of these: the change, `PR.md`, `reviews/app-v9/review.md`,
`second-review.md`, the waiting-line records. I was not given the author's reasoning beyond what those files
say. **The question.** C2 read the desktop's 36-series result paint over 100 ms, which trips the waiver's
reopen rule R2. Does R2 reopen B1? What is phone 200 Chart to table at 127 ms? Is the waiting-line change (C4)
acceptable on its records? Is B1 waived as granted, waived with new conditions, or reopened?

Inputs: `project/review.md` (the rubric), `project/README.md` ("Responsiveness and feedback"),
`project/components/Progress/README.md`, `reviews/app-v9/review.md` (B1), `PR.md` (the top section, C1 and C2),
`second-review.md`, `tools/ab.cjs` and `tools/summarise.cjs` (how the figures are made),
`app/src/explore/waiting.tsx` at HEAD with its hunk of `app.patch`, `data/ab-*.json`, `data/c1-desktop.json`,
`data/c2-desktop.json`, `data/c2-phone.json`, `data/merge-desktop.json`, `data/2026-11-27/ab-*.json`, and
`waiting-line/` (README, `summary.txt`, `frames-desktop.json`, `frames-phone.json`).

**I measured nothing.** I ran no browser and no timing job. The author **measured every figure here**, on this
shared 4-core machine (Chromium headless shell, CPU 4x, Fast 4G, the development mock). I **recomputed** them
from the raw runs with the quantile and pairing rules of `ab.cjs` and `summarise.cjs`, and they agree with
`PR.md`. A figure marked **modelled** is my own arithmetic on those runs, not a measurement.

## Ruling: the waiver stands for 37 to 200 series, with new conditions; B1 is not resolved

1. **R2 does not reopen the waiver, and R2 is replaced.** The waiver covers 37 to 200 series. Nothing in C1 or C2
   weakens its grounds. The paired runs, which cancel the session, show that the change made the 36-series paint
   **quicker**: last byte −32 ms (quicker in 18 of 20 pairs) in the morning and −36 ms (17 of 20) in C2. The
   merged tree is not slower than the change alone: +2 ms, 8 of 20. As written, R2 lets one session's absolute
   figure decide a row within 10 % of its limit, and this machine cannot do that (§1). R1 has the same flaw. Both
   are replaced below (R1′, R2′, and the session rule).
2. **The desktop's 36-series last-byte row is not met. This is not a reading of one session.** Four blocks of 20
   runs of builds that the paired test shows equal read 90, 109, 104 and 101 ms. Pooled over all 80 runs, the
   75th percentile is **105 ms**, and 32 of the 80 runs are over 100. That row was never waived. By C2's own
   words, "B1 is not resolved" until it is met. I do not waive it now: there is an untried invisible remedy as
   large as the excess (§1.6).
3. **Phone 200 Chart to table is an existing part of B1, not a new blocker.** The change did not cause it: paired
   −4 ms in both sessions. It is not noise either: it has read over 100 ms in 4 of the 8 blocks measured since the
   first review, on every build. The two sessions of the final build disagree (91 and 127 ms), so it is
   unsettled, and an unsettled row is not met (§2). The phone's 36-series Chart to table (101, then 86) is in the
   same state.
4. **C4: no finding against the change on its records, but not closable from records alone.** The rubric's
   reviewer works "from the images, the running view and this system". Neither the images nor the running view
   exists for the transition. The dashboards' waiting lines use the same hook and have no records (§3).

The waiver has still not taken effect. **B1 stands until C3, C4 and the new C5 are met** (§4). The app's pull
request cannot merge on B1 yet.

## 1. Does R2 reopen B1?

### 1.1 What R2 says and what it was for

R2: "Any 36-series result paint over 100 ms at the 75th percentile in a judged session. That row was never
waived." It does two jobs:

- It guards the waiver's edge: the waiver must not quietly come to cover 36 series.
- It restates that B1's 36-series rows must be met.

Read literally, R2 is tripped. C2 is a judged session (load at most 1.3 at run start), and it read 109 ms from
the last byte. Before ruling, I tested whether that reading means what R2 assumes it means.

### 1.2 Session drift on code that did not change

| Build (unchanged) | Row | Session (UTC), calibration | p75, ms |
|---|---|---|---|
| cc50ea2 | Desktop 200, body read | First reviewer, 2026-11-27 ~01:00, 344 ms | 143 |
| cc50ea2 | Desktop 200, body read | C1, 2026-11-28 11:10, 391 ms | 205 (**+43 %**) |
| c4a154b | Desktop 36, body read / last byte | Morning, 09:19, 325 ms | 113 / 127 |
| c4a154b | Desktop 36, body read / last byte | C2, 11:20, 336 ms | 127 / 140 (+12 % / +10 %) |
| c4a154b | Phone 200, Chart to table | Morning, 10:06, 326 ms | 88 |
| c4a154b | Phone 200, Chart to table | C2, 11:50, 346 ms | 104 (+18 %) |
| c4a154b | Phone 36, Chart to table | Morning / C2 | 113 / 96 (**−15 %**) |

The body-read row does not depend on the DevTools buffers (second review, §1), so the first line pair is
comparable. Two things follow:

- Between sessions, the same code moves by 10 to 43 %, at loads the rule judges (1.0 to 1.8).
- The drift is not even one factor. Between the same two phone sessions, one row got slower and another got
  quicker. Load does not explain it either. The morning's desktop session read quickest (90 ms) at the highest
  load of the four blocks (1.7 to 1.8). C2 read slowest (109) at 1.0 to 1.3.

Within a session, the distribution-free 90 % interval for a 75th percentile of 20 runs is about ±10 to 15 ms.
Examples: [84, 112] around 90, and [105, 127] around 109. **So one session's absolute value cannot decide a row
within about 10 % of its limit, in either direction.** The morning's 90 ms did not show a pass any more than C2's
109 shows a fail. The second review drew the same line ("a 75th percentile within about 10 ms of 100 cannot be
called from one session"), and so did the first reviewer ("I would not accept a thin-margin row … that was not
measured twice").

### 1.3 Can the calibration figure normalise the sessions? No.

`ab.cjs` records one calibration per session: the median of three timings of a Node loop at the start, taken on
the host and not in the throttled renderer.

| Block (desktop, 36, last byte, "after") | Calibration | p75 | Scaled to the morning's calibration (**modelled**) |
|---|---|---|---|
| Morning (the change) | 325 ms | 90 | 90 |
| C2 (merged tree) | 336 ms | 109 | 106 |
| Merge check (the change / merged tree) | 395 ms | 104 / 101 | 85 / 83 |

The block with the slowest calibration read quicker than C2. In C1, the calibration rose 14 % against the first
reviewer's session while cc50ea2 rose 43 %. Scaling by the calibration gives answers that contradict each other.
The README also forbids it: "The calibration ratio is context only: it never makes a loaded run judged." The
same applies to using it to judge a row.

### 1.4 Can the in-session "before" build normalise them? Not to a decision.

Each session also ran c4a154b, an unchanged build. Scaling C2's "after" by the ratio of the two sessions'
"before" figures gives the following (**modelled**):

- last byte 98.5 ms, body read 86 ms, in "a morning-like session";
- scaled the other way, the morning's 90 ms becomes 99.8 ms in "a C2-like session".

The model assumes that the session multiplies both builds alike. It does not: the after/before ratio was 0.71 in
the morning and 0.78 in C2. That 10 % disagreement is the whole margin. Nothing makes one session the reference
either. So this normalisation lands the row at its limit (98 to 100 ms) and cannot decide it.

### 1.5 What the paired differences show

A paired difference compares two builds measured run by run in one session, so the session cancels out.

| Session | Pair | Body read | Last byte |
|---|---|---|---|
| Morning, desktop 36 | after less before | −29 ms, quicker in 18 of 20 | −32 ms, 18 of 20 |
| C2, desktop 36 | after less before | −36 ms, 17 of 20 | −36 ms, 17 of 20 |
| Merge check, desktop 36 | merged tree less the change | +4 ms, 8 of 20 | +2 ms, 8 of 20 |

- The change made 36 series quicker by about a third of the budget, in both sessions, with either build taken
  first.
- The merge added nothing beyond noise.
- Nothing in the code has moved this row the wrong way.
- The waiver's grounds at 200 series are intact:
  - C1 ruled the regression out (−8 and −12 ms).
  - C2's 200-series figures are inside R1's bounds: desktop 125 / 153, phone 101 / 122.

So nothing gives a reason to withdraw the waiver.

A paired difference measures what a change did. It does not measure whether a budget is met. The budget is an
absolute figure "on the reference setup", and the paired runs say nothing about where the row sits against 100.

### 1.6 Where the row sits, from all the evidence

| Block of 20 (desktop, 36, last byte) | p75 | 90 % interval | Runs over 100 |
|---|---|---|---|
| Morning, the change | 90 | 84 to 112 | 4 |
| C2, the merged tree | 109 | 105 to 127 | 12 |
| Merge check, the change | 104 | 102 to 129 | 9 |
| Merge check, the merged tree | 101 | 99 to 116 | 7 |
| **All 80 pooled** (equal builds, by the paired test) | **105** | | **32** |
| Merged tree only, 40 pooled | 106 | | 19 |

The two afternoon blocks are separate invocations, started 41 minutes apart, with calibrations of 336 and
395 ms. They agree that the row is over, and the morning block disagrees. The best estimate, with every block
counted, is a few milliseconds over the limit.

The harness's own copy of the body is in this row. It cost 10 to 20 ms at 200 series, on weak evidence
(`clone.json`). Scaled to the 36-series body it would be 2 to 4 ms (**modelled**), which still leaves the row at
101 to 103.

By the system's own definition of "arrives" (`tools/speed.mjs`: the harness's copy has been read), the row is met:

- desktop: 80, 97, 89 and 89 ms, 92 pooled;
- phone, 36 series: 70 and 77 (body read), 78 and 89 (last byte).

The last-byte row is still binding. B1 named it ("over from the last byte"), and the waiver kept "both
definitions". It is also the nearer figure to what a person's browser does, which has to read and parse the
body.

**Answer to question 1.** R2 does not reopen the waiver. The waiver's subject, 37 to 200 series, is unaffected,
and the paired data show no code made the 36-series case worse. R2's single-session test is replaced (§4). Its
conclusion survives the better test, though, and for the right reason: **the desktop's 36-series last-byte row is
not met.** B1 is therefore not resolved, under C2 as the second review wrote it.

**Why I do not waive the 36-series row.** C2 allows "a second reviewer of its own". I apply the second review's
four tests:

- Nothing false is shown: holds.
- The excess is small: holds, a few ms against a release-to-paint of about 670 ms.
- Refusing keeps something worse: arguable.
- **Nothing invisible is left: fails.** `PR.md` names the legend table's layout as an invisible remedy of perhaps
  5 to 10 ms, and nobody has tried it. That is the size of the excess. The rubric makes no exception for small
  misses, and the second review's own test excludes time "that can be taken out invisibly".

Once the remedy has been tried, measured and shown not to bring the row inside, a reviewer may extend the waiver
to this row on the four tests.

## 2. Phone 200 Chart to table at 127 ms

| Session | Build | p75, ms | Runs over 100 | Paired (after less before) |
|---|---|---|---|---|
| First reviewer, two runs | cc50ea2 | 122, 114 | | |
| 2026-11-27, paused | 0aa0f7a before / after | 96 / 98 | 4 / 5 | −0, 10 of 20 |
| Morning | c4a154b / the change | 88 / 91 | 3 / 1 | −4, 11 of 20 |
| C2 | c4a154b / merged tree | 104 / 127 | 6 / 8 | −4, 11 of 20 |

- **Not caused by the change.** The paired median is −4 ms in both sessions. In C2, split by which build went
  first, it is +19 and −15 ms. That is an order effect of about 17 ms: whichever build was taken second in a pair
  read slower. The 23 ms gap between C2's two 75th percentiles is that effect showing in the tail, not the
  change. The table and the chart-to-table path were not touched (`PR.md`, "Chart to table at 200 series on the
  phone").
- **Not new.** B1 named this row ("chart to table within 100 ms at 200 series on the phone"). The waiver excludes
  it ("Chart to table at any size").
- **Not noise to be set aside.** Across four sessions and four builds it read over 100 in 4 of 8 blocks (122, 114,
  104, 127) and under in 4 (96, 98, 88, 91). It sits at its limit, with a 40 ms swing between sessions. The two
  sessions of the final build disagree (91, 127). Pooled over their 40 runs it is 98 ms, which is context only
  (see the session rule). A local change has "No waiting state" and 100 ms.

**Answer to question 2.** It is the existing B1 row, unsettled, and the change did not cause it. To settle it
takes a third session (the session rule, §4). If it is not met, it needs a fix: the profile puts the time in the
table's layout (30 ms) and style (18 ms), so the fix is in its markup or CSS, with identity shown. Otherwise it
needs a waiver of its own after that remedy has been tried. The phone's 36-series Chart to table is in the same
state: 101 then 86 ms, sessions disagreeing, not caused (paired −9, +1).

## 3. The waiting line (C4), on its records

**What the records show** (`waiting-line/summary.txt`, checked against the frame files):

- **Long wait (200 series).** The line now goes in the frame that first paints the new chart:
  - desktop: 3 of 3 runs, against 1 frame over the new chart in 3 of 3 before (83 to 133 ms);
  - phone: 2 of 3 runs. In the third, the line had not had its 300 ms when the result rendered, so the effect
    took it away 67 ms later, as the minimum requires.
  - Unthrottled minimum runs at 200 series: 0 of 5 frames over the new chart on the desktop (4 of 5 before), and
    2 of 5 on the phone (4 of 5 before).
- **The 300 ms minimum is kept.** In all 30 "after" minimum runs at 4, 36 and 200 series, on both layouts, `held`
  is 299.9 to 300.1 ms where the answer comes inside the first 300 ms, and more where it comes later. None was cut
  short.
- **The words never change** ("Waiting for the query."), and the head's "Showing the previous query" was never
  wrongly shown or dropped. No frame shows a state that the Stale data row would fail.
- **The code.** The new branch calls `setShown(false)` during render only when the wait is over and `shownAt` is
  older than the minimum. Under `StrictMode`'s double render it is idempotent, and production builds do not
  double-render. It reads a ref in render, which React discourages and which is not a defect here. The record
  agrees: no frame and no `moved` reading shows a line removed early.

**What a reviewer cannot judge from records alone,** and so what C4 still needs:

1. **Images.** The rubric's reviewer "works from the images, the running view and this system", and "every
   finding cites an image". AGENTS.md: "A design pull request without before/after images is not ready." The
   screencast images were dropped because they missed frames. That was right, but it leaves nothing to cite. C4
   needs the frame in which the new 200-series chart is first painted, before and after, at 1440 and 400 px, in
   both themes. They must be taken by a method shown to capture the frame that the record names, with the
   record's frame time printed beside each image.
2. **The running view**, watched by the reviewer at both layouts.
3. **The other users of the hook.** `useWaiting` also drives the dashboards' waiting lines (each panel, the list,
   one dashboard) and the shell's session check. No record covers them. Each needs at least one before-and-after
   frame record of a wait over 400 ms.
4. **The phone's late removals at 36 series.** Two of 3 "after" runs held the line 333 and 367 ms. The frames
   around the removal are idle; in run 1 the line went 4 frames past its minimum with no long frame in between.
   The most "before" held was 317 ms. The hook's path for a line short of its minimum is the same in both builds,
   so this is probably noise, but 3 runs cannot show it. It needs 20 runs per build, or an explanation. This is
   minor: it does not break the minimum, but it keeps the line over a drawn result for longer.

**A finding outside this change, for the system's owner (F5).** In both builds, whenever the answer comes inside
the line's first 300 ms, "Waiting for the query." stays over the drawn result until the 300 ms are up. That was
100 to 150 ms on the desktop and 250 to 300 ms on the phone, at 36 series, 2 to 15 frames. The Progress
component requires this ("keep it for at least 300 ms so it never flashes"). The second review's sentence that
the line says its words "until the new result is drawn" does not match the records.

- The Feedback row asks for an indicator that is accurate.
- The system's own minimum makes the sentence untrue for up to 300 ms.

That conflict belongs to the system, not to this change, which shortens it. R6 is not tripped. R6 covers the
waiver's extra paint time, and this hold happens at 4 and 36 series whatever the paint time.

**Answer to question 3.** On the records, the change does what it says and breaks nothing that can be seen in
them. My verdict on the records would be approve. The rubric does not accept a verdict without images or the
running view, so **C4 stays open** until items 1 to 3 exist and a reviewer who did not write the change has
judged them. Item 4 may follow as a minor.

## 4. Amended rules and the new condition

These replace R1 and R2 of `second-review.md`. R3 to R6, F1 to F4, the scope and the 2026-12-31 lapse stand
unchanged.

**The session rule (SR).** This is how a timing row is decided on this machine, for this waiver and for B1's
unwaived rows.

1. A **session** is one invocation of `tools/ab.cjs`: 20 alternating runs per build, every run judged by the load
   rule. Sessions on the same row start at least 30 minutes apart. Every session includes an anchor build (c4a154b,
   or the final build of this change once it merges), so that a paired comparison always exists.
2. **Every session run on a row is reported, whatever it reads.** None is dropped, and none is replaced by a rerun.
3. **Two sessions that agree decide the row**: both at or under the limit at the 75th percentile, met; both over,
   not met. **If they disagree, a third session is run**, and the 75th percentile of all runs of the three, pooled,
   decides. Once a row is decided for a build, more sessions of the same build do not reopen the decision.
4. Builds that a paired test in one session shows equal (C1's rule) may be pooled for a row.
5. Neither the calibration figure nor the load scales a figure. Both are context (README).
6. A paired difference decides what a change did. It never decides whether a budget is met.

**R1′. A regression at 200 series** reopens B1 if either of these holds:

- **Paired:** a session of a later Explore build against the anchor, at 200 series, shows the later build slower
  by C1's rule (paired median over +10 ms, with 5 or fewer of 20 pairs quicker), on body read or last byte, at
  either layout.
- **Absolute:** by SR, the row is over the bounds below. A single session over a bound is not a reopening; it
  obliges the next session.

  | Layout | Body read | Last byte |
  |---|---|---|
  | Desktop | 140 ms | 170 ms |
  | Phone | 115 ms | 130 ms |

**R2′. The 36-series rows.** They were never waived, so they are not a reopen rule. They are condition C5, below.
Once they are met, B1 reopens on either of these:

- a paired regression at 36 series against the anchor, by C1's rule;
- the row found over 100 ms by SR in later sessions.

**C5 (new). B1's unwaived rows are met by SR on the final build.** Applied to the sessions that exist:

| Row ("after") | Sessions, p75 ms | By SR |
|---|---|---|
| Desktop 36, body read | 80, 97, 89 / 89 | Met |
| **Desktop 36, last byte** | 90, 109, 104 / 101; pooled 105 (80 runs) | **Not met** |
| Phone 36, body read / last byte | 70, 77 / 78, 89 | Met |
| Desktop 36, Chart to table | 59, 98, 80 / 94 | Met |
| Desktop 200, Chart to table | 94, 93 | Met |
| **Phone 36, Chart to table** | 101, 86 | **Undecided: third session** |
| **Phone 200, Chart to table** | 91, 127 | **Undecided: third session** |

To meet C5:

- **Desktop 36, last byte.**
  - Try the invisible remedy that `PR.md` names (the legend table's layout), or any other that changes nothing a
    person sees. Show identity as for this change.
  - Show the gain paired against the current final build, beyond noise by C1's rule.
  - Then meet the row by SR on the new build.
  - If the remedies are tried and the row is still not met, a reviewer who did not write them may consider waiving
    this row on the second review's four tests. It is not waived until then.
- **Phone 36 and phone 200, Chart to table.**
  - Run a third phone session of the final build against c4a154b, 20 runs, at 36 and 200 series.
  - Pooled over the three sessions, a 75th percentile at or under 100 meets the row.
  - If a row is not met, it needs a fix in the table's markup or CSS, with identity shown, or a waiver of its own
    after that remedy has been tried.
  - Neither row was caused by this change, and neither is covered by its waiver.

## What must happen before the app's pull request can merge, on B1

1. **C5**: the desktop's 36-series last-byte row brought inside and met by SR, and the third phone session for
   the two Chart-to-table rows (with a fix if either is not met).
2. **C4**: the images, the running view and the dashboards' records, judged by a reviewer who did not write the
   change.
3. **C3**: the pull request's description says what `PR.md` says, this ruling included. The second review's list
   applies too, with the e2e suites green on the tree that merges.
4. Then the waiver takes effect for 37 to 200 series, under R1′, R2′ and R3 to R6, and it lapses on 2026-12-31
   unless F1 is decided.

The rest of the app-v9 review (B2, B3, M1 to M3, the images from the final build) was not reviewed here.

## Residual uncertainty

- **The drift is not explained.** SR makes thin rows decidable, but it does not remove the cause. Two or three
  sessions sample a machine whose state moved one build by 43 % in a day. A row that SR calls met at 98 ms can
  still be over on a real device (R4).
- **The 36-series excess is a few milliseconds.** A real device or a quieter machine might put the row inside. I
  hold the line because the rubric has no small-miss exception, and because there is an untried invisible remedy
  of the same size.
- **The harness's copy of the body at 36 series** (2 to 4 ms) is modelled from a weak 200-series figure.
- **The C4 records are 3 runs per case** for the frame records and 5 per case for the minimum. They cover Explore
  only.

## How this was checked

Script:
`/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad/b1-third/an.py`, run as
`python3 -I an.py <file.json> …` from `data/`. For each case and build it prints:

- the 75th percentile by `ab.cjs`'s rule (`ceil(0.75·n) − 1`) and the median;
- the count of runs over 100;
- the shortest distribution-free interval of at least 90 % coverage for the 75th percentile, from order
  statistics;
- the paired median, split by which build was taken first.

Inline checks did the rest:

- paired medians with `summarise.cjs`'s lower median (they reproduce `PR.md`);
- the pooled 75th percentiles;
- the calibration and in-session-control scalings (modelled);
- run timestamps and loads;
- one frame-by-frame listing (`frames-phone.json`, 36 series, "after" run 1).

I read `waiting.tsx` at HEAD with `git show`.

## Housekeeping

This file is the only one written. Nothing else in the tree was edited, and nothing was committed or pushed. No
browser, server, timing job or Cloudflare call was run.
