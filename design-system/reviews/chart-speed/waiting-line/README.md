# The waiting line's last frames (C4 of `../second-review.md`)

**For a reviewer who did not write the change. Not judged here.**

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
