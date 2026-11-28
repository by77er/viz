# Second review: viz design system v9, blocker B1

Reviewed 2026-11-26 by a second reviewer who wrote neither the system nor `review.md`. Scope: B1 of
`review.md` only (a reload at 400 px with a coarse pointer comes back at the wrong scroll position). Nothing
else in v9 was reviewed again. Inputs: `project/review.md`, `project/README.md`, `review.md`,
`spikes/s12-reload-on-a-phone/README.md`, the author's probes, and the built system on disk (`dist/` and
`reviews/system-v9/compositions/` as committed in 99910a6; the commits since add only images under
`reviews/app-v9/`). Everything below was measured here, on copies in the session scratchpad.

## Decision: B1 is waived

**The miss is made by the measuring tool, and I found how.** Playwright's `hasTouch` makes the pointer coarse
through DevTools touch emulation. While a reload is under way, the document that is about to be replaced
loses that emulation: between its `beforeunload` and its `pagehide`, its pointer turns fine. If it is laid out
once more in that state, every `@media (pointer: coarse)` rule stops applying, the page gets shorter, the
scroll position is clamped or re-anchored in the shorter page, and that position is what the browser records
and restores into the reloaded document. The reloaded document itself is laid out correctly and never moves,
which is why the layout shift is 0.0000.

The decisive evidence:

1. **The outgoing document says so itself.** With a recorder in the first document that survives the reload:
   at `beforeunload` it reads pointer coarse, height 9,659, scroll 8,859. At `pagehide`, about 5 to 30 ms
   later, it reads pointer **fine**, height **9,124**, scroll **8,324**. The reload then comes back at exactly
   8,324. 9,124 − 800 = 8,324, the end of the shorter page: the "535 px short" is the difference between
   the page's coarse and fine heights. This happened in 8 of 8 touch-scrolled reloads, and in 9 of 9
   script-scrolled ones with their own numbers (E4).
2. **The reloaded document plays no part.** When the reload is answered with a plain 30,000 px page that has
   no viz in it, that page is restored to the same wrong offset, 8,324, in 10 of 12 (E3).
3. **A page that is not viz does the same.** 24 blocks and one rule, `@media (pointer: coarse) { .b { height:
   400px } }`: 8 of 8 reloads come back elsewhere with the recorder, 7 of 16 without. The same page without
   the rule: 0 of 8, although its pointer also turns fine at `pagehide` (E6, image `02`, appendix A).
4. **With a pointer that stays coarse, the system's pages land where they were, every time.** The pointer can
   be made coarse in Blink itself (`--blink-settings`), with no touch emulation, which is how a phone has it:
   as a fact about the device that no navigation changes. Same pages, same coarse layout (9,659 px), same
   touch drags, same reload: **0 of 204** reloads came back elsewhere, against 8 of 8 and 9 of 9 with the
   same recorder under touch emulation. That covers every chart on every page the audit's reload pass covers,
   three times (E7, E10).

It is not headless Chromium, as `review.md` supposed: the full browser does it too, in its new headless mode
and in a window, in versions 153 and 157 (E8). It is touch emulation.

## Grounds, tied to the rubric

- **The row.** Narrow and zoom (blocker): "layout shift under 0.05 when the page loads scrolled to a region
  (reloaded scrolled to each chart, as `tools/audit.mjs` does, and landing where it was)". The row asks what
  a person at 400 px with a coarse pointer gets.
- **What failed was not that.** The failing measurement is of a document whose pointer the emulator changes
  from coarse to fine while the reload is under way. No person is looking at that document any more, and on
  a device whose pointer really is coarse nothing changes it. Measured with a pointer that stays coarse, the
  row is met: 53 of 53 charts land within 1 px, twice with the audit's own pass and once with my script, and
  the reloaded documents have no layout-shift entry of any kind, including those the browser flags (E10).
- **It is not a defect of the system's pages**, which is where I differ from `review.md`. Its controls were
  right and its inference was reasonable: a plain page and the unstyled markup do not miss, the system's
  pages do. But those two controls have no rule that depends on the pointer. A page with one such rule and
  nothing else misses (E6). Any responsive page that sizes things by pointer type will.
- **The waiver.** "A blocker may be waived only by a second reviewer, who records why." This file is that
  record. I use the waiver, and do not call the finding withdrawn, because the check the first reviewer
  asked for, a real phone, has still not been made.

`review.md` says that with B1 settled by a fix or a recorded waiver, v9 can be approved. I did not review
anything else, so that verdict is the first reviewer's and stands as written. The audit's reload pass still
fails at random as shipped; "checks pass" needs the change under "Recommendation for the audit" first.

## Residual uncertainty, and what would reopen B1

- **No real phone was tested**, by me or by anyone. The waiver rests on a mechanism observed in desktop
  Chromium builds and on a pointer made coarse by a command-line switch, which stands in for a phone and is
  not one. That a phone's pointer type does not change during a navigation is training knowledge, not
  measured. I did not read Chromium's source, and one web search found no filed issue for this.
- **B1 reopens on a reproduction on a real phone**: the test in `spikes/s12-reload-on-a-phone/README.md`, on
  the pages that spike has live at its URL. A reproduction means coming back on different content, hundreds
  of pixels away, as in image `01`. A difference of about the height of the browser's address bar at the very
  end of a page is not one (training knowledge, not measured: a phone's address bar reappears on reload).
- **It also reopens without a phone** if a reload lands elsewhere here with the pointer coarse and no touch
  emulation (the changed audit pass below failing on landing), or if someone shows a real device whose
  pointer type changes as a page navigates.

Not explained, and not needed for the decision:

- What decides, on a page with no recorder, whether the outgoing document is laid out again before it goes.
  I measured 2 of 8 to 11 of 12 on the same page. With anything that reads layout at `pagehide` it is every
  run: 41 of 41 on the Chart preview with my recorder (E2, E4, E8), 24 of 24 on the minimal page (E6), and
  20 of 20 with a page that saves its own position there (E9).
- Why an animation-frame loop in the first document lowers the rate (0 of 12, 1 of 8), when a scroll listener
  or a timer does not (E5). The pointer still turns fine in every such run.
- Why the system's page, reloaded into itself, passes through 8,638 before settling at 8,324, and why the
  minimal page reloaded into itself lands 300 px short when the recorded offset is 2,400 px short. Chromium
  restores by a saved anchor element as well as by offset; I did not establish that this is the reason.
- Why the fine-pointer height of the outgoing Chart preview differs with how it was scrolled: 9,124 after a
  touch scroll through the page, 8,220 after a jump, 7,878 at the top. A fresh fine-pointer load is 7,217.

## Experiments

**Setup.** `dist/` and `reviews/system-v9/compositions/` copied to the scratchpad and served from a local
static server (`dist/viz.css` and the Chart preview are identical to the author's `s12/full` copy).
Playwright 1.63.0. Browsers: `chromium_headless_shell` 157.0.8103.78 (Playwright's default, what the audit
uses) unless said; full Chromium 153.0.8010.12 in E7 and E8. One browser at a time. 4 cores, shared with
other jobs; the 1-minute load was 0.3 to 5.3 and is printed with every run.

**The probe** is `probe.mjs` in
`/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad/review2/`, run as
`node probe.mjs '<options as JSON>'`. Defaults: the Chart preview, 400 × 800, `hasTouch` and `isMobile`, a
fresh context per try, touch drags that end in a fling (the author's `Input.dispatchTouchEvent` sequence)
until the page is at its end, 700 ms, `page.reload()`, read 1.8 s later; "elsewhere" is more than 1 px.
`"initWhen":"reload"` adds my instrumentation to the reloaded document only, and every row below has it
unless said, because instrumenting the first document changes the result (E1, E5). The scratchpad can be
cleared: appendix A is a complete reproduction that needs none of it.

### E1. Reproduction

| Run | Command | Came back elsewhere |
|---|---|---|
| The author's probe, unchanged, on the author's copy | `DRAG=1 node probe-touch-reload.mjs s12/full dist/preview/Chart.html 12` | 8 of 12, each 535 px short |
| The same on my copy | `DRAG=1 node probe-touch-reload.mjs review2/site dist/preview/Chart.html 12` | 9 of 12, each 535 px short |
| My probe | `{"tries":12,"initWhen":"reload"}` | 10 of 12, each 535 px short, layout shift 0.0000 |
| My probe, a frame-by-frame recorder in the first document too | `{"tries":12}` | **0 of 12** |
| The audit's reload pass as shipped, twice | `node tools/audit.mjs --root <copy> --reload-only` | 1 of 53 at 400 coarse each time, a different page each time (Panel preview 103 px; claims composition 139 px); 0 of 53 at 1500 px; exit 1 both times |
| Every chart of every page with one, jump then reload, touch emulation | `node shiftall.mjs emulated` | 10 of 53, from 18 to 6,983 px away |

Trace of a miss in the reloaded document: the page is 9,659 px tall at the first reading
(`DOMContentLoaded`) and never changes; the pointer is coarse throughout; scroll is 8,638 at
`DOMContentLoaded` and 8,324 from about 115 to 170 ms. With script off the served page is also 9,659 px. So
the restore is not clamped by a page that is still short: the position being restored is wrong.

### E2. Is it a fling that has not settled?

No.

| Run | Command | Result |
|---|---|---|
| 3 s between the last drag and the reload | `{"tries":12,"initWhen":"reload","settle":3000}` | 11 of 12 |
| 8 s | `{…,"settle":8000}` | 5 of 12 |
| A drag that stops before the finger lifts, no fling, with the E4 recorder | `{"tries":6,"initWhen":"reload","scroll":"slowdrag","firstLog":true}` | 6 of 6 |
| No touch input at all: `scrollTo` from script to each of nine charts and the end, four times round | `{"tries":40,"initWhen":"reload","scroll":"jump","settle":500,"jumpList":[963,2109,3164,4263,6184,7186,7789,8414,8924,"end"]}` | 7 of 40 |

With the recorder, `scrollend` fires about 0.9 s before `beforeunload`. The positions the page passes through
differ from run to run (for example 0, 1,868, 5,202, 6,142 … against 0, 1,293, 3,622, 7,154) and the landing
is the same number every time, so it is not a position caught in mid-fling.

**A correction to the spike's README.** It says the miss never follows a synthetic scroll gesture (0 of 36).
That gesture does not scroll the page under touch emulation here. The author's own probe, with one line
changed to print positions, reports "from 0 to 0" in 3 of 3 tries, and my probe shows the same on the Chart
preview and on a plain page (`"scroll":"gesture"`: every position 0). The 0 of 36 was measured at the top of
the page and says nothing. The miss needs neither a fling nor a touch.

### E3. Is the wrong position decided before the reload, or during the restore?

Before. The server answers the reload with a plain page: one `div`, 30,000 px tall, no stylesheet
(`"swapOnReload":"tall"`). The browser restores into it whatever it recorded for the first document.

| Run | Command | Result |
|---|---|---|
| Touch scroll to the end, reload served as the plain page | `{"tries":12,"initWhen":"reload","swapOnReload":"tall"}` | 10 of 12 restored to 8,324; 2 to 8,859 |
| The same, twice more | 8 tries, 6 tries | 4 of 8; 5 of 6; always 8,324 |
| Then `scrollBy(0,-1); scrollBy(0,1)` from script before the reload | `{…,"nudge":true}` | 10 of 12 at 8,324: a later scroll from script does not correct it |
| Then `scrollTo(y)` from script | `{"tries":48,…,"thenList":[200,500,1000,2000,5000,8000,8300,8500,8600,8700,8800,8859]}` | 16 of 48. Misses land on fixed places: 8,500 to 8,800 all at 8,223; 8,000 and 8,300 at 7,962 and 7,966; the end at 8,324 |
| Jumps only | `{"tries":40,…,"scroll":"jump","settle":500,"jumpList":[…as E2…],"swapOnReload":"tall"}` | 12 of 40: 7,186 → 5,630; 7,789 → 7,420; 8,414 → 7,277; the end → 7,420 |

Before the reload, script and DevTools agree that the page is where it should be: `scrollY` 8,859, layout
viewport `pageY` 8,859, visual viewport offset 0 and scale 1, content 400 × 9,659
(`Page.getLayoutMetrics`), in hits and misses alike.

### E4. What happens to the outgoing document

A recorder is added to the first document after it loads (`"firstLog":true`). It has no animation-frame
loop. On each `scroll`, `scrollend`, `resize`, media-query change, `beforeunload`, `pagehide` and
`visibilitychange` it writes the scroll position, page height and pointer type to `sessionStorage`, which the
reloaded document reads back.

| Run | Command | Result |
|---|---|---|
| Touch scroll to the end | `{"tries":8,"initWhen":"reload","swapOnReload":"tall","firstLog":true}` | **8 of 8.** `beforeunload`: 8,859 / 9,659 / coarse. `pagehide`: 8,324 / 9,124 / **fine**. Restored to 8,324 |
| Jump to three charts, three times | `{"tries":9,…,"scroll":"jump","jumpList":[7789,8414,"end"],"firstLog":true}` | **9 of 9.** `beforeunload`: target / 9,659 / coarse. `pagehide`: 7,420, 7,277, 7,420 / 8,220 / **fine**. Restored to those |
| A recorder that reads only the pointer, nothing that needs layout | `{"tries":8,…,"firstLog":"light"}` | pointer fine at `pagehide` in **8 of 8**; came back elsewhere in 2 of 8 |
| The same with an animation-frame loop in the first document | `{…,"firstLog":"light","firstEval":"raf"}` | fine in 8 of 8; elsewhere in 1 of 8 |
| Touch emulation without mobile emulation (`hasTouch` only) | `{"tries":6,"initWhen":"reload","mode":"touch","firstLog":true}` | 6 of 6, fine at `pagehide` |

8,220 − 800 = 7,420: this is `review.md`'s "always to 7,420".

The pointer turns fine in every run. The reload comes back elsewhere when the outgoing document is laid out
again after that and before it is gone. Reading its position at `pagehide`, as my recorder does and as any
page that saves its own scroll position does, forces that layout, and then it is every run.

### E5. What in the first document changes the rate

| First document also runs | Command | Came back elsewhere |
|---|---|---|
| an animation-frame loop | `{"tries":12,…,"swapOnReload":"tall","firstEval":"raf"}` | 0 of 12 |
| a passive scroll listener | `"firstEval":"listener"` | 10 of 12 |
| a 16 ms timer | `"firstEval":"timer"` | 7 of 12 |
| 600 ms of animation frames after the fling has ended | `"rafAfter":600` | 2 of 12 |
| a screenshot after the fling has ended | `"shotMid":true` | 5 of 12 |

This is why the rates in `review.md` and the spike differ so much from run to run and from probe to probe:
they depend on what else the first document happens to be doing. I did not find the rule (see "Not
explained").

### E6. A page that is not viz

`min/index.html`: 24 blocks of 300 px, 400 px under `@media (pointer: coarse)`, and nothing else.
`min/nomedia.html`: the same with every block 400 px and no media rule. Appendix A has the page and a script.

| Run | Command (all with `"root":"…/review2/min"`) | Result |
|---|---|---|
| Touch scroll, recorder, reload served as the plain page | `{"page":"index.html","tries":8,"initWhen":"reload","swapOnReload":"tall","firstLog":true}` | **8 of 8**, 2,400 px short. `pagehide`: 6,400 / 7,200 / fine |
| The same, no recorder | 16 tries | 7 of 16 |
| Jump, recorder | `"scroll":"jump"` | 8 of 8 |
| Jump, no recorder | 16 tries | 7 of 16 |
| Reloaded into itself, recorder | no `swapOnReload` | 8 of 8, 300 px short (image `02`) |
| **No media rule** | `"page":"nomedia.html"`, recorder | **0 of 8**; pointer fine at `pagehide` in 8 of 8 |
| Fine pointer, no emulation | `"mode":"fine","scroll":"jump"`, recorder | 0 of 8 |

### E7. A pointer that stays coarse

`--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1`
makes Blink's pointer coarse without DevTools touch emulation. Checked on the Chart preview: `(pointer:
coarse)`, `(any-pointer: coarse)` and `(hover: none)` all match, and the page is 9,659 px tall, as under
touch emulation (`native.mjs`). `isMobile` alone gives the phone's viewport. Touch drags injected through
DevTools still scroll the page.

| Run, Chart preview | Command | Came back elsewhere |
|---|---|---|
| Jump to three charts, recorder | `{"tries":9,"initWhen":"reload","mode":"native","scroll":"jump","settle":500,"jumpList":[7789,8414,"end"],"firstLog":true}` | **0 of 9**; pointer coarse at `pagehide` 9 of 9 |
| Touch scroll to the end (8,859 before every reload), recorder | `{"tries":12,"initWhen":"reload","mode":"native-mobile","firstLog":true}` | **0 of 12**; coarse 12 of 12 |
| The same, no recorder | 12 tries | **0 of 12** |
| Full Chromium 153, new headless, recorder | `{"tries":6,…,"browser":"full","mode":"native-mobile","firstLog":true}` | 0 of 6 |
| Full Chromium 153, in a window (Xvfb), recorder | `xvfb-run -a node probe.mjs '{…,"browser":"headed",…}'` | 0 of 6 |
| The audit's reload pass with this pointer, twice (E10) | `node tools/audit-native.mjs --root <copy> --reload-only` | 0 of 53 and 0 of 53 at 400 px; 0 findings; exit 0 |
| Every chart, jump then reload (E10) | `node shiftall.mjs` | 0 of 53 |

Total with a pointer that stays coarse, on the system's pages: 0 of 204 (9 + 12 + 12 + 6 + 6 + 106 + 53).

### E8. Other browsers here

Chart preview, touch emulation, touch scroll to the end.

| Browser | With the recorder | Without |
|---|---|---|
| Headless shell 157.0.8103.78 | 8 of 8 | 10 of 12 |
| Full Chromium 153.0.8010.12, new headless (`"browser":"full"`) | 6 of 6, fine at `pagehide` | 5 of 12 |
| Full Chromium 153.0.8010.12, in a window under Xvfb (`"browser":"headed"`) | 6 of 6, fine at `pagehide` | 6 of 12 |

No other engine and no other Chromium version is installed here. Firefox and WebKit were not tested.

### E9. Other ways to come back, and a page that restores itself

| Run | Command | Result |
|---|---|---|
| Go to another page and back, back-forward cache off | `{"tries":12,"initWhen":"reload","reload":"back","args":["--disable-features=BackForwardCache"]}` | 2 of 12, 535 px short |
| `location.reload()` from script | `"reload":"js"` | 6 of 12 |
| `history.scrollRestoration = 'manual'`; the page saves `scrollY` on `scroll` and `pagehide` and restores it at `load` | `{"tries":10,"manual":"load","raf":false}` | **10 of 10** elsewhere: the page reads 8,324 at `pagehide` |
| The same, restoring as soon as the page is tall enough | `"manual":"grow"` | 10 of 10 |
| The page saves on `scroll` only | `"manual":"load-scrollonly"`, `"manual":"grow-scrollonly"` | 1 of 10; 0 of 10 |
| Scroll-anchor serialization switched off | `"args":["--disable-features=ScrollAnchorSerialization"]` | 10 of 12. I did not verify that the switch took effect |

**Restoring from script is not a fix and none is needed.** It confirms `review.md`'s row (10 of 10) and shows
why: the page reads the emulator's position. Saving on `scroll` only mostly escapes it, and still missed
once. It would replace a browser behaviour that works when the pointer is stable with page script that has
failure modes of its own, to satisfy an emulator.

### E10. The audit's reload pass

Run on a scratch copy of `design-system/` (`dist/`, `tools/`, `src/`, `project/`, `fixtures/`, the v9
compositions). `tools/audit-native.mjs` is `tools/audit.mjs` with the change in appendix B.

| Run | Result |
|---|---|
| As shipped, v9, twice | exit 1 both times; 1 landing finding each, on different pages (E1) |
| Changed, v9, twice | exit 0 both times; 106 reloads each; 0 of 53 elsewhere at 400 px; 0 of 53 at 1500 px; largest shift 0.0000 |
| `shiftall.mjs`, v9, pointer coarse without emulation: every layout-shift entry of the reloaded document, flagged or not | 53 reloads on 9 pages; 0 elsewhere; **no entry at all** |
| `shiftall.mjs emulated`, v9 (control: the script can see a miss) | 10 of 53 elsewhere |

**Mutants**, each applied to a scratch copy, never to the tree, and run on the Chart preview only:

| Mutant | Shipped pass at 400 coarse | Changed pass at 400 px | Both, elsewhere |
|---|---|---|---|
| The author's T3.audit: four charts with no reservation in their markup. Two runs of each pass | `reload-shift`: not caught. Its one finding in two runs is the emulator's miss (chart 10 of 10, 1,178 px, shift 0.0000) | `reload-shift`: **not caught** in two runs | `reserve` catches all four charts at both layouts, every run. `reload-shift` at 1500 px: 0, 1, 3 and 4 findings in the four runs |
| Mine: 200 px added at the top of the page 300 ms after load, scroll anchoring off. One run of each | caught: 10 findings, by the pixels the chart moves after the jump. Layout shift read 0.000 | caught: 9 findings, the same way. Layout shift read 0.000 | 1500 px: caught, shift 0.085 |
| Mine: T3.audit and scroll anchoring off. Two runs, changed pass only | not run | not caught | `reserve` catches it; 1500 px: 1 and 3 findings |

So the change loses nothing the shipped pass had at 400 px, and removes the only failure the shipped pass had
on v9 in my runs.
Reported plainly: **T3.audit survives the reload pass's own two measures at 400 px in both forms**; only
`reserve` catches it there.

**A second weakness, found on the way.** Under mobile emulation the browser marks layout shifts early in a
load `hadRecentInput: true`, and the audit sums only unmarked entries.

- `min/shift.html` (200 px added at the top 300 ms after load), jumped to 3,000 and reloaded, 3 tries each
  (`{"page":"shift.html","scroll":"jump","jumpTo":3000,"settle":900,"showShifts":true,"raf":false,"mode":…}`):
  the entry is `[≈313 ms, 0.25, false]` at 400 px fine and with the pointer coarse without `isMobile`. It is
  `[≈313 ms, 0.25, true]` with `hasTouch` and `isMobile`, and with `isMobile` and the pointer coarse in
  Blink. A quarter-viewport shift after a reload therefore reads 0.0000 at the audit's 400 px layout.
- T3.audit with the pointer coarse and stable (`node shiftall.mjs native ds-mut preview/Chart.html`): the
  reload at chart 1 has one entry, 0.0934 at 101 ms, marked. Counting every entry would catch it; the audit
  reads 0.0000.
- The same marking is given to a shift that follows a `scrollTo` within 50 ms under `hasTouch` and
  `isMobile` (at 100 ms, on one page of two), and not at a fine pointer without emulation (`cls2.mjs`).

This does not touch v9: with every entry counted, v9's 53 reloads have none (above). It does mean the
"0.0000" figures quoted for 400 px reloads, in the audit and wherever a harness filtered the same way, were
partly blind. I did not establish why the browser marks them.

### Runs that failed, were void or were skipped

- Every `"scroll":"gesture"` run under touch emulation or with the stable coarse pointer is void: the gesture
  did not scroll (positions all 0), so "0 came back elsewhere" there means nothing. One such run of 12 tries
  was killed by its timeout with no result.
- One run meant to stop the touch scroll at 5,000 px is not used: the flings overshot to the end.
- My first height trace hung because my own script blocked its server; I fixed the script and reran it. A
  recursive search of the scratchpad timed out and I stopped it; it was not needed.
- Not done: a real phone; Firefox and WebKit; any Chromium other than 153 and 157; reading Chromium's source;
  the audit's other passes; a rerun of anything else in `review.md`.

## Recommendation for the audit check

**Scope it. Keep it failing, do not rate-limit it.** A limit on a rate would keep measuring the emulator,
would need a number nobody can justify (I saw from 0 of 12 to 9 of 9 on one page), and would let a real
regression through under it. The check is right; its pointer is wrong.

1. **In the reload pass, make the 400 px layout's pointer coarse in Blink, not by touch emulation**
   (appendix B: a browser launched with the `--blink-settings` switch, a context with `isMobile` and without
   `hasTouch`, and a guard that fails the pass if `(pointer: coarse)` does not match, because the switch is a
   Chromium internal and may change). Evidence: E10. Every other pass keeps touch emulation; they need touch
   events, and they do not measure a document across a navigation.
2. **In the same pass, count every layout-shift entry, marked or not.** The pass gives no input, so no entry
   there can be the result of one. Evidence: E10, second weakness. Check `tools/speed.mjs` for the same: it
   keeps the marked entries apart (`shiftAfterInput`), and I did not check whether its phone layout judges
   them.
3. **Any later test that reads a position, a size or a pointer-dependent style across a navigation at the
   phone layout**, in the system or the app, needs the same pointer. Under touch emulation a page that reads
   its own layout at `pagehide` gets the fine-pointer page every time.

## What the author must change

Nothing in the system's CSS, markup or scripts.

1. `tools/audit.mjs`: recommendation 1, so that the check passes for the right reason and "checks pass" is
   true. Recommendation 2 with it.
2. Keep the text true: `project/README.md`, "Responsiveness and feedback", says the audit reloads at both
   layouts; say how the coarse pointer of that pass is made, and why. Add the two changes and T3.audit's
   survival at 400 px to the mutants' record.
3. `spikes/s12-reload-on-a-phone/README.md`: correct "a synthetic gesture reproduced nothing" (it did not
   scroll) and the reading that the fling matters; record this result. The phone test is still the one thing
   that would reopen B1, so keep the pages up until the owner has run it or decided not to, then delete the
   Worker as the README says.
4. Record this waiver, with its residual uncertainty, in `response.md` and in the pull request, as the rubric
   requires.

## Images

| File | Shows |
|---|---|
| `review-images/02-reload-at-400-touch-emulation-lands-short-coarse-without-emulation-lands-in-place-chart-preview-and-a-page-that-is-not-viz.png` | Top row, the Chart preview at 400 × 800: before the reload at 8,859; after it under touch emulation at 8,324, on the backtest panel; after it with the pointer coarse without emulation at 8,859. Bottom row, the same three for the 24-block page: 8,800, then 8,500, then 8,800. Rendered here |

## Housekeeping

- The shared tree: this file and one image in `review-images/` (0.24 MB) were added. Nothing else was
  edited, and nothing was committed. Git: read-only commands (`log`, `status`, `diff --stat`).
- Everything else is in the scratchpad folder named above: the copies, the probes, three mutant copies, the
  changed audit and its JSON results.
- Servers: each script starts its own static server on a free local port and closes it when it ends. None is
  running. No browser of mine is running. Other jobs on the machine were running browsers of their own
  during this session, which is the load above.
- No Cloudflare resource was touched, and the spike's pages were not fetched.
- One web search for a filed Chromium issue (no project details in the query) found none. The nearest
  result, a 2015 Chromium change saying mobile emulation sets the coarse pointer
  (https://codereview.chromium.org/1343843004), is secondary and nothing above relies on it.

## Appendix A. A complete reproduction

Needs only Playwright and its Chromium. Run here as `node repro.mjs`; result below it.

```js
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title>
<style>body { margin: 0 } .b { height: 300px; box-sizing: border-box; border-top: 1px solid } @media (pointer: coarse) { .b { height: 400px } }</style></head>
<body>${Array.from({ length: 24 }, (_, i) => `<div class="b">Block ${i + 1}</div>`).join('')}</body></html>`
const server = createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end(html) })
const port = await new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)))
const coarseInBlink = '--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1'
for (const [name, args, context] of [['DevTools touch emulation (hasTouch, isMobile)', [], { hasTouch: true, isMobile: true }], ['coarse in Blink, no touch emulation (isMobile)', [coarseInBlink], { isMobile: true }]]) {
  const browser = await chromium.launch({ args })
  for (const record of [true, false]) { const lands = []; let seen = ''
    for (let t = 0; t < 8; t++) { const ctx = await browser.newContext({ viewport: { width: 400, height: 800 }, ...context }), page = await ctx.newPage()
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
      // the recorder reads the page's position and height as it is hidden, as a page that saves its own scroll position would
      if (record) await page.evaluate(() => addEventListener('pagehide', () => sessionStorage.setItem('hide', `pointer ${matchMedia('(pointer: coarse)').matches ? 'coarse' : 'fine'}, scrollY ${scrollY}, height ${document.documentElement.scrollHeight}`)))
      await page.evaluate(() => scrollTo(0, 1e7)); await page.waitForTimeout(500)
      const before = await page.evaluate(() => `pointer ${matchMedia('(pointer: coarse)').matches ? 'coarse' : 'fine'}, scrollY ${scrollY}, height ${document.documentElement.scrollHeight}`), y0 = await page.evaluate(() => scrollY)
      await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(1000)
      const [y1, hide] = await page.evaluate(() => [scrollY, sessionStorage.getItem('hide')]); lands.push(Math.round(y1 - y0)); if (record && !seen) seen = `before the reload: ${before}; as it was hidden: ${hide}`
      await ctx.close() }
    console.log(`${name}, ${record ? 'position read at pagehide' : 'nothing added to the page'}: ${lands.filter((d) => Math.abs(d) > 1).length} of ${lands.length} came back elsewhere (px: ${lands.join(', ')})${seen ? '\n    ' + seen : ''}`) }
  await browser.close() }
server.close()
```

```
DevTools touch emulation (hasTouch, isMobile), position read at pagehide: 8 of 8 came back elsewhere (px: -300, -300, -300, -300, -300, -300, -300, -300)
    before the reload: pointer coarse, scrollY 8800, height 9600; as it was hidden: pointer fine, scrollY 6400, height 7200
DevTools touch emulation (hasTouch, isMobile), nothing added to the page: 2 of 8 came back elsewhere (px: 0, -300, 0, 0, 0, -300, 0, 0)
coarse in Blink, no touch emulation (isMobile), position read at pagehide: 0 of 8 came back elsewhere (px: 0, 0, 0, 0, 0, 0, 0, 0)
    before the reload: pointer coarse, scrollY 8800, height 9600; as it was hidden: pointer coarse, scrollY 8800, height 9600
coarse in Blink, no touch emulation (isMobile), nothing added to the page: 0 of 8 came back elsewhere (px: 0, 0, 0, 0, 0, 0, 0, 0)
```

## Appendix B. The change to the audit's reload pass that was run in E10

`diff tools/audit.mjs tools/audit-native.mjs`, on the scratch copy. It closes the first browser before
opening the second, so one browser runs at a time. It does not include recommendation 2.

```diff
508c508
< const browser = await chromium.launch(), results = [], started = Date.now()
---
> let browser = await chromium.launch(); const results = [], started = Date.now()
556c556,558
<   const ctx = await browser.newContext({ viewport: { width: L.w, height: 900 }, ...(L.coarse ? { hasTouch: true, isMobile: true } : {}) })
---
>   // second review: the 400 px layout's pointer is made coarse in Blink itself, not by DevTools touch emulation, which drops the coarse pointer from the outgoing document as a reload commits
>   if (L.coarse) { await browser.close(); browser = await chromium.launch({ args: ['--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1'] }) }
>   const ctx = await browser.newContext({ viewport: { width: L.w, height: 900 }, ...(L.coarse ? { isMobile: true } : {}) })
560c562
<   const lay = `${L.w}${L.coarse ? ' coarse' : ''}`, noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: L.w, height: 900 }, ...(L.coarse ? { hasTouch: true, isMobile: true } : {}) })
---
>   const lay = `${L.w}${L.coarse ? ' coarse' : ''}`, noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: L.w, height: 900 }, ...(L.coarse ? { isMobile: true } : {}) })
580a583
>         if (L.coarse && !(await page.evaluate(() => matchMedia('(pointer: coarse)').matches))) results.push({ page: p, config: lay, kind: 'load', msg: 'second review: the pointer is not coarse in this run' })
```
