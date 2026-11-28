# The waiting line's last frames (C4 of `../second-review.md`)

**For a reviewer who did not write the change. Not judged here.** The third review's requests (images of the exact frame, the dashboards, the phone's late removals) are answered at the end, "C4 after the third review".

## The change

`app/src/explore/waiting.tsx`, `useWaiting` (part of `../app.patch`, now in the tree). Before, the
waiting line was taken away by an effect after the render that showed the result, so for a wait over
400 ms the page rendered twice for one answer and the line stayed over the new result until the next
frame. Now, when the wait is over and the line has been up for its 300 ms minimum, the render that
shows the result also leaves the line out. A line that has not yet had its 300 ms is still taken away
by the effect when they are up. The second review asked for: a frame-by-frame record at both layouts
of a wait over 400 ms ending in a 36- or 200-series result, before and after; and a check that a line
shown at 400 ms still stays 300 ms when the answer comes at 450 ms.

For the reviewer, from `../second-review.md`: the new code calls `setShown` during render and reads
`performance.now()` and a ref there; that is allowed, but not pure, and the app renders under
`StrictMode`. The same hook also drives the waiting lines of the dashboards (each panel, the list, one
dashboard) and the shell's session check; these records cover Explore only.

## How it was recorded

`../tools/waiting-frames.cjs` (its header says exactly what each field is). "Before" is commit
`c4a154b`'s `app/`, "after" the merged tree (`67d9d73`, `dist/` of 11:05 UTC), both built in the scratch
area, one mock (`c4a154b`'s), measured here on this shared 4-core machine under the shared lock.

1. **The frame record**: CPU 4x and Fast 4G with DevTools keeping no body copies, as `../tools/ab.cjs`;
   Explore loaded with the case's query, then Run query pressed. For 36 series the mock holds the
   answer 300 ms so that the wait passes 400 ms; the 200-series answer takes over a second on Fast 4G by
   itself. Every frame from the release of the press to 600 ms after the panel's last change is
   recorded in a `requestAnimationFrame` callback: the line (present, and its words), how many times
   the chart's plot has been written since the press, whether "Showing the previous query" is in the
   head, and how many DOM changes the panel had since the previous frame. Explore uses no animation
   frame and the chart draws synchronously, so what is read there is what that frame paints (a
   ResizeObserver could still change it after layout). A second reading is taken in a task posted from
   the callback; where it differs (`moved`), the result's render had run before that task, 45 to
   160 ms later, so the second reading shows a later state, once (phone, 200 series, "after" run 2) a
   state between two tasks that no frame painted (the chart written, the line not yet removed; the
   next frame shows both done). The callback's reading is the record.
   3 runs per build, case and layout, the builds alternated.
2. **The minimum**: unthrottled, the mock holding every query 450 ms, so the line shows at 400 ms and
   the answer arrives at about 450 to 600 ms. `held` is the first painted frame without the line less
   the first with it; frames come every 16.7 ms, so a line held exactly 300 ms reads 299.9 to 300.1.
   5 runs per build, case and layout, at 4, 36 and 200 series.

Times are milliseconds after the release of Run query, by the frame's start.

## Desktop (1440 x 900, fine pointer), 12:05 to 12:08 UTC, load 1.1 to 1.6

| Case | Build | Last byte | New chart painted | Line gone | Frames with the line over the new chart | For how long |
|---|---|---|---|---|---|---|
| 36 series | before | 599, 550, 523 | 601, 570, 542 | 718, 687, 692 | 2, 3, 4 | 117, 117, 150 ms |
| 36 series | after | 591, 538, 540 | 603, 560, 567 | 703, 710, 700 | 4, 6, 4 | 100, 150, 133 ms |
| 200 series | before | 1382, 1288, 1235 | 1402, 1303, 1254 | 1536, 1403, 1338 | **1, 1, 1** | **133, 100, 83 ms** |
| 200 series | after | 1329, 1262, 1254 | 1348, 1279, 1270 | 1348, 1279, 1270 | **0, 0, 0** | **0** |

- **200 series** (the line has been up about 900 ms when the answer comes): before, the frame that
  shows the new chart still shows "Waiting for the query." over it, and the next frame, which takes the
  line away, comes 83 to 133 ms later (the second render of the page for one answer). The panel changes
  in 2 frames after the last byte. After, the new chart and the line's removal are in the same frame,
  and the panel changes in 1 frame.
- **36 series** (the answer comes about 150 to 200 ms after the line appears): in both builds the line
  stays over the new chart until its 300 ms are up (100 to 150 ms, 2 to 6 frames), and is taken away by
  the effect, as before. The words never change ("Waiting for the query."), and "Showing the previous
  query" was not shown in any frame (the query run again is the one on screen).

| Minimum, desktop | Build | `held`, ms (5 runs) | Answer's last byte | Line gone |
|---|---|---|---|---|
| 4 series | before | 300.1, 299.9, 300, 300, 300 | 493 to 512 | 700 to 712 |
| 4 series | after | 300, 299.9, 299.9, 300, 299.9 | 489 to 515 | 702 to 711 |
| 36 series | before | 300, 299.9, 300, 300.1, 300 | 552 to 625 | 700 to 712 |
| 36 series | after | 300, 300, 299.9, 300, 300.1 | 553 to 573 | 705 to 713 |
| 200 series | before | 467 to 567 | 845 to 875 | 874 to 972 |
| 200 series | after | 467 to 550 | 823 to 935 | 869 to 961 |

At 4 and 36 series the answer comes inside the line's first 300 ms, and in every run of both builds
the line stayed exactly its 300 ms (to the frame) and no more. At 200 series, unthrottled, the answer
comes after the 300 ms; before, the line was over the new chart for one frame in 4 of 5 runs, after in
none.

## Phone (400 x 800, touch, coarse pointer, device scale 2), 12:23 to 12:26 UTC, load 1.3 to 1.7

| Case | Build | Last byte | New chart painted | Line gone | Frames with the line over the new chart | For how long |
|---|---|---|---|---|---|---|
| 36 series | before | 437, 429, 426 | 456, 440, 453 | 706, 707, 720 | 14, 13, 14 | 250, 267, 267 ms |
| 36 series | after | 453, 442, 431 | 473, 446, 450 | 773, 696, 733 | 15, 13, 13 | 300, 250, 283 ms |
| 200 series | before | 676, 665, 708 | 702, 683, 726 | 818, 733, 843 | **1, 1, 1** | **117, 50, 117 ms** |
| 200 series | after | 722, 675, 694 | 735, 696, 703 | 735, 696, 770 | **0, 0, 1** | **0, 0, 67 ms** |

- **200 series**: on this layout the answer comes about 300 ms after the line appears (shown at about
  400 ms, last byte at 665 to 722 ms), so the minimum decides. Before, the line was over the new chart
  for one frame in every run (50 to 117 ms). After, it went in the frame that showed the chart in two
  runs; in the third (new chart at 703 ms, line shown at 403 ms) the line had not had its 300 ms when the
  result was rendered, so the effect took it away one frame later (67 ms), as the minimum requires.
- **36 series**: the answer comes inside the line's first 300 ms; in both builds the line stays over
  the new chart until its 300 ms are up (250 to 300 ms, 13 to 15 frames). In "after" run 1 the line went
  at 773 ms (held 367 ms, 4 frames past its minimum), in "after" run 3 at 733 ms (held 333 ms); in
  "before" the most was 317 ms. Not looked into further (3 runs each).

| Minimum, phone | Build | `held`, ms (5 runs) | Answer's last byte | Line gone |
|---|---|---|---|---|
| 4 series | before | 300, 300, 300, 300.1, 300 | 472 to 483 | 708 to 710 |
| 4 series | after | 299.9, 300.1, 299.9, 299.9, 299.9 | 472 to 483 | 708 to 710 |
| 36 series | before | 300, 300, 299.9, 300, 300 | 503 to 527 | 709 to 710 |
| 36 series | after | 300, 299.9, 299.9, 300, 299.9 | 499 to 525 | 707 to 709 |
| 200 series | before | 300 to 400 | 649 to 744 | 709 to 808 |
| 200 series | after | 299.9 to 349.9 | 660 to 723 | 709 to 757 |

**On both layouts the line kept its 300 ms minimum in every run of both builds** (299.9 to 300.1 ms
is 18 frames at 16.7 ms each); none was cut short. In the 200-series minimum runs the line was over
the new chart for one frame or more in 4 of 5 runs before (one of them 2 frames) and 2 of 5 after.

## What a person sees, in short

With a long wait (the line up for more than 300 ms when the result is drawn), the line now goes in the
frame that shows the new chart; before, it stayed over the new chart for one more frame, 50 to 133 ms
here (that frame is long: it is the page's second render for one answer). With a shorter wait, nothing
changed: the line stays until its 300 ms are up, over the new chart, in both builds. The line's words
and the head's labels are the same in every frame of both builds.

## Files

- `frames-desktop.json`, `frames-phone.json`: every run, every frame (`frames`), and the derived
  figures; the build roots are scratch paths.
- `summary.txt`: the tables above, printed from the two files.
- Not kept: the screencast frames `waiting-frames.cjs --images` saved for the first run of each case.
  Chromium's screencast delivered only some frames while the main thread was busy, and in the desktop
  200-series "before" run it missed the frame with the line over the new chart, so the images would
  show less than the record does.

## C4 after the third review (2026-11-28, evening)

`../third-review.md` §3 asked for three things before a reviewer can judge C4, and one minor. All four are here. **Not
judged here.** Builds: "before" is `c4a154b`'s `app/`, "after" the merged tree (`4dea3c5`'s `app/`, the same waiting hook
as `67d9d73`); the mock is `c4a154b`'s. Measured here, under the shared lock, 13:37 to 14:00 UTC.

### 1. Images of the exact frame

`images/` holds, per case, one sheet: before on the left, after on the right; for each build the first frame that shows
the new result and, where the line was still over it, the first frame without the line. Above each image is its
frame's record: the frame time after the press, whether the waiting line was in that frame and its words, how many
times the plot had been written, whether "Showing the previous query" (or, on a dashboard, "range") was shown, and the
image's BeginFrame time. Cases: Explore at 200 and at 36 series, and a dashboard panel; 1440 px (desktop) and 400 px
(phone); light and dark. 12 sheets: `images/explore-200-desktop-light.png` and so on; the frames in them are listed below, one run per case.

**How a frame and its image are tied** (`../tools/frame-shots.cjs`, its header has the detail). Chromium runs with
begin-frame control: the page makes a frame only when the tool sends one (`HeadlessExperimental.beginFrame`, with
`--run-all-compositor-stages-before-draw`), and the call returns when that frame is drawn, with a screenshot of it. The
tool sends one every 16.7 ms (or when the last returned, if that took longer), each with its own frame time. The page
keeps the same record as `waiting-frames.cjs`, in a `requestAnimationFrame` callback, whose timestamp is that frame
time. Every kept image is matched to its record by frame time, and **in every run the clock offset between the two was
the same for every matched frame to within 0.1 ms** (the rAF timestamp's resolution); every image that is kept was
matched (`shots-*.json`: `framesMatched`, `maxOffsetDeviationMs`, and per frame whether it had an image). A frame
without damage has no screenshot (nothing changed on screen) and so no image.

**What this method changes.** Frames come from the tool, not from vsync, and a frame waits while the previous one's
screenshot is taken; so the times in these records are not the reference setup's, and how many frames fall in a gap
differs. These images show what each frame drew; `frames-*.json` (natural frames) is still the record that times
things. Two consequences show in the sheets. At 200 series, before, the frame without the line comes 76 to 159 ms after the new chart
here (50 to 133 ms in the natural records). On the phone at 200 series the answer's last byte came here 220 to 312 ms after the
line's first frame (under 300 ms in three of the four runs), before the line had had its 300 ms by the hook's clock; so
in both builds and both themes the line is over the new chart for one frame and goes when its minimum is up. **The phone's 200-series sheets therefore show the minimum, not the
change**; the natural records (`frames-phone.json`: 2 of 3 runs "after" with no frame of the line over the new chart, 3
of 3 "before" with one) are the evidence for the change on the phone. The desktop's 200-series sheets show it: before,
the first frame with the new chart still has "Waiting for the query." over it; after, the line is gone in that frame.

In the phone sheets the whole page sits 16 px higher in the frame without the line than in the frame with it, in both
builds (everything moves together, so the scroll position changed). It was not looked into. It may come from the
scrolled start these images need: the timed runs start at the top and recorded no layout shift.

On the phone the result is below the fold, so the page was scrolled first (Run query to the top); for the phone's
dashboard, its first chart panel was scrolled to the top and Refresh, then off screen, was pressed by script
(`element.click()`), not by touch. "before" has no Monitors link in the navigation: the monitors view was merged after
`c4a154b`.

| Case | Build | Last byte | First frame with the new result: line in it? | First frame without the line | Frames with the line over the new result | Frames matched / recorded; offset spread |
|---|---|---|---|---|---|---|
| dashboard panel, desktop, dark | before | 749 | 727 ms: no | 727 ms | 0 | 40 / 40; 0.092 ms |
| dashboard panel, desktop, dark | after | 739 | 740 ms: no | 740 ms | 0 | 37 / 38; 0.089 ms |
| dashboard panel, desktop, light | before | 743 | 726 ms: no | 726 ms | 0 | 42 / 43; 0.088 ms |
| dashboard panel, desktop, light | after | 714 | 703 ms: no | 703 ms | 0 | 42 / 43; 0.088 ms |
| dashboard panel, phone, dark | before | 830 | 811 ms: no | 811 ms | 0 | 62 / 63; 0.099 ms |
| dashboard panel, phone, dark | after | 811 | 800 ms: no | 800 ms | 0 | 62 / 63; 0.09 ms |
| dashboard panel, phone, light | before | 815 | 799 ms: no | 799 ms | 0 | 59 / 60; 0.096 ms |
| dashboard panel, phone, light | after | 807 | 792 ms: no | 792 ms | 0 | 61 / 62; 0.096 ms |
| Explore 200, desktop, dark | before | 1345 | 1350 ms: yes | 1509 ms | 1 | 65 / 65; 0.097 ms |
| Explore 200, desktop, dark | after | 1394 | 1410 ms: no | 1410 ms | 0 | 68 / 68; 0.095 ms |
| Explore 36, desktop, dark | before | 599 | 623 ms: yes | 763 ms | 1 | 41 / 41; 0.082 ms |
| Explore 36, desktop, dark | after | 598 | 618 ms: yes | 724 ms | 1 | 39 / 39; 0.092 ms |
| Explore 200, desktop, light | before | 1240 | 1260 ms: yes | 1386 ms | 1 | 66 / 66; 0.089 ms |
| Explore 200, desktop, light | after | 1215 | 1242 ms: no | 1242 ms | 0 | 64 / 64; 0.092 ms |
| Explore 36, desktop, light | before | 543 | 579 ms: yes | 705 ms | 3 | 41 / 41; 0.098 ms |
| Explore 36, desktop, light | after | 574 | 614 ms: yes | 729 ms | 1 | 38 / 38; 0.076 ms |
| Explore 200, phone, dark | before | 706 | 716 ms: yes | 792 ms | 1 | 70 / 70; 0.082 ms |
| Explore 200, phone, dark | after | 650 | 656 ms: yes | 737 ms | 1 | 65 / 65; 0.08 ms |
| Explore 36, phone, dark | before | 466 | 474 ms: yes | 710 ms | 11 | 68 / 68; 0.091 ms |
| Explore 36, phone, dark | after | 446 | 467 ms: yes | 721 ms | 12 | 65 / 66; 0.098 ms |
| Explore 200, phone, light | before | 669 | 674 ms: yes | 786 ms | 1 | 69 / 69; 0.099 ms |
| Explore 200, phone, light | after | 626 | 643 ms: yes | 723 ms | 1 | 65 / 65; 0.094 ms |
| Explore 36, phone, light | before | 459 | 469 ms: yes | 728 ms | 10 | 63 / 63; 0.094 ms |
| Explore 36, phone, light | after | 432 | 441 ms: yes | 717 ms | 12 | 66 / 66; 0.091 ms |

### 2. The dashboards' waiting lines (the same hook)

`waiting-frames.cjs --dashboard` (new): the dashboard `service_red`, its first panel with a chart, the mock holding every
query 700 ms, Refresh pressed; the record follows that panel (its line `panel-progress`, its plot, "Showing the previous
range"). 3 runs per build and layout. `frames-dashboard-desktop.json`, `frames-dashboard-phone.json`.

| Layout | Build | Line shown, ms | First frame with the panel's new chart | Line gone | Held | Frames with the line over the new chart |
|---|---|---|---|---|---|---|
| desktop (13:50 UTC) | before | 393, 394, 384 | 727, 711, 684 | 760, 711, 700 | 367, 317, 317 | 1, 0, 1 |
| desktop (13:50 UTC) | after | 390, 386, 385 | 723, 686, 701 | 723, 686, 718 | 333, 300, 333 | 0, 0, 1 |
| phone (13:51 UTC) | before | 378, 404, 387 | 678, 754, 703 | 711, 754, 703 | 333, 350, 317 | 1, 0, 0 |
| phone (13:51 UTC) | after | 386, 385, 393 | 702, 685, 710 | 702, 685, 710 | 317, 300, 317 | 0, 0, 0 |

With a 700 ms answer the line comes at about 385 to 405 ms and the panel's answer at about 680 to 755 ms, so these waits
end close to the line's 300 ms minimum. Where the line had had its 300 ms when the panel's result rendered, it went in
the frame that drew the new chart in both builds except one run each (one frame later). "Showing the previous range" was
never shown (the range did not change). The words were "Waiting for the query." in every frame of both builds. The list
and one-dashboard waits and the shell's session check were not recorded.

### 3. The phone's late removals at 36 series: 20 more runs per build, and the cause

`frames-phone-36-20runs.json` (`waiting-frames.cjs --phone --series 36 --runs 20 --min-runs 0`, 13:41 to 13:44 UTC; the
mock's 300 ms hold is now set after the page has loaded, so only the press waits). How long the line stayed past its 300
ms minimum, in frames (16.7 ms each):

| Build | 0 frames | 1 | 2 | 3 | 4 | Median past the minimum | Most |
|---|---|---|---|---|---|---|---|
| before | 6 | 9 | 5 | 0 | 0 | 16.6 ms | 33.4 ms |
| after | 1 | 10 | 5 | 3 | 1 | 16.7 ms | 66.7 ms |

So the 33 and 67 ms of the first three runs were not one-offs: "after" kept the line two or more frames past its minimum
in 9 of 20 runs, "before" in 5 of 20, and three or four frames only "after" (4 runs). The minimum was never cut short
(the fewest frames held is 300 ms, 18 frames).

**What causes it, from the code and the records** (an explanation that fits them; it was not instrumented further). The
line goes when `useWaiting`'s hide timer, set for the rest of the 300 ms, has fired and the render it asks for has been
painted. Two delays add to the 300 ms, and the records cannot separate them:

- **The start of the count.** `shownAt` is stamped in a passive effect (`useEffect`) after the render that shows the line.
  React runs passive effects in a task after the commit, and at the latest before its next render. In these runs the
  answer's last byte comes 16 to 81 ms after the line's first frame, while the page is busy receiving and reading the body,
  so the stamp can be taken late. In 39 of the 40 runs the line's removal less 300 ms falls between the line's first frame
  and the frame that first drew the result (in the first record's "after" run 1, exactly on the result's frame: removal at
  772.6 ms, new chart at 472.6 ms).
- **The end of the count.** At 4x CPU the timer, and the render of the page it triggers, can wait behind other work (the
  result's own render, the elapsed-time tick) before a frame shows the line gone.

"After" reads the body in pieces while it downloads (this pull request's parser change), so more work lies between the
line's render and its effect, which fits the longer tail; that is a reading, not a measurement. The stamping effect is the
same in both builds (`git diff c4a154b HEAD -- app/src/explore/waiting.tsx` changes only how it resets to 0, and adds the
render-time branch). Stamping in a layout effect (`useLayoutEffect`, run before the frame is painted) would start the
count at the line's first frame in both builds; that is a behaviour change for the app's reviewer and is not made here.

### Files added

- `images/*.png`: the 12 sheets (1.7 MB in all); `shots-*.json`: their records (every frame, whether it was matched to an
  image, and the images kept, by file name). The single frames (105 PNG files, 8.9 MB) are not committed: the sheets hold, at full
  size, the frames a reviewer is asked about (the first with the new result, the first without the line); the others kept
  (the frame before the result, each frame with the line over the new result) are listed in the records, and
  `../tools/frame-shots.cjs` writes them all again.
- `frames-dashboard-desktop.json`, `frames-dashboard-phone.json`, `frames-phone-36-20runs.json`.
- `../tools/frame-shots.cjs`, `../tools/compose.py` (the sheets), `../tools/waiting-frames.cjs --dashboard`.
