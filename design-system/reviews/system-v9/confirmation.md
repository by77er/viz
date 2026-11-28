# Confirmation review: viz design system v9, after the waiver's follow-ups

Reviewed 2026-11-26 (23:11 to 23:20 UTC for the runs) by a third reviewer, an agent session that wrote neither the system,
`review.md`, `second-review.md` nor the follow-up commit 397e8b8. Scope, and only this: whether the four things `second-review.md`
required of the author were done and done correctly; whether the changed reload pass can pass for the wrong reason; whether the
author's stated results match the committed evidence; whether `response.md` and `project/README.md` are true; and, with that, what
verdict v9 can be recorded with. Inputs: `project/review.md`, `project/README.md`, `review.md`, `second-review.md`, `response.md`
(read to check its claims, not taken on trust), the code of `tools/audit.mjs`, `tools/speed.mjs`, `tools/mutants-corpus.mjs` and
`tools/mutants.mjs` as committed, the `evidence/second-review-*` files, and the tree. Nothing else in v9 was reviewed again: the
visual rows of the rubric stand as `review.md` judged them.

## Verdict: approve

No blocker stands unwaived and there are no majors. B1 stays **waived, not withdrawn** (`second-review.md`); the four required
changes are in the tree and the reload pass now passes for the reason it should. Eight minors are carried below (c1 to c8), two of
them found here. Three things are not part of the verdict but limit how the system may be used as ground truth for the app's
review; they are under "Before the system is used to review the app".

The system that is approved is the one `review.md` judged: `src/`, `dist/`, `project/tokens.json`, `project/components/`,
`fixtures/` and `reviews/system-v9/compositions/` are identical between 99910a6 (what the second reviewer read) and HEAD
(`git diff --stat`, empty). Only two tools, the corpus and text changed.

## The four required items

| # | Required by `second-review.md` | Done | What I checked |
|---|---|---|---|
| 1 | `tools/audit.mjs`: the reload pass's 400 px pointer coarse in Blink, not by touch emulation, with a guard (recommendation 1); every layout-shift entry counted (recommendation 2) | **Yes, both, correctly** | The code, lines 569 to 604. For the pass's 400 px layout the first browser is closed and one is launched with `--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1`; both contexts (with and without script) take `isMobile` and no `hasTouch`. `(pointer: coarse)` is read on every page as opened (before its charts are counted, so also on pages with none), on the page served without script, and on every reloaded page; a miss is a `pointer` finding on a system page, so exit 1. The jump's and the reload's entries are summed marked and unmarked and judged on the **sum** (`j.shift + j.marked >= 0.05`, `r.shift + r.marked >= 0.05`). Every other pass still uses `hasTouch` (lines 514, 547). Then my run, my probe and my copy with the switch removed, below |
| 1b | Recommendation 2 checked for `tools/speed.mjs` | **Yes**, with one imprecision (c2) | The code, lines 87 to 92 and 125 to 130. `load-shift` rows (a load given no input) count every entry. The `shift` row counts every unmarked entry and every marked one before the page's first trusted `pointerdown`, `mousedown`, `touchstart`, `keydown` or `click`; what was counted from marked entries and what was left out are printed and written to `--out`. The phone layout keeps `hasTouch`, rightly: it needs touch events and reads nothing across a navigation |
| 2 | The text true (`project/README.md`, Responsiveness and feedback: how the pass's pointer is made and why); the two changes and T3.audit's survival in the mutants' record | **Yes** | Each sentence added to `project/README.md` against the code: the switch and `isMobile`; "which every other pass uses"; "the pass fails if `(pointer: coarse)` does not match" (my copy without the switch: exit 1); "counts every layout-shift entry"; "`tools/speed.mjs` counts a marked shift from before its first input". All hold. `tools/mutants-corpus.mjs`: T3.audit's description and note now say `reserve` kills it and the reloads do not, dependably; T8.audit and T9.audit added. The corpus imports as 178 entries with 178 distinct ids, 48 of them run the audit, as the README and the response say. `tools/mutants.mjs` runs the copy's own `tools/audit.mjs`, so T9.audit does test the mutated tool |
| 3 | `spikes/s12-reload-on-a-phone/README.md`: the synthetic gesture, the fling, this result; pages kept up | **Yes, as text** | The "0 of 36" is marked void with the reason (the gesture did not scroll; `evidence/second-review-gesture-positions.txt`: "from 0 to 0" three times); the reading that the fling matters is withdrawn with the second review's counts; the mechanism and the 0 of 204 are recorded as that review's, not the spike's; the README says the Worker is not deleted and why. **Not checked:** that the Worker is still serving. I did not touch Cloudflare or fetch the pages |
| 4 | The waiver and its residual uncertainty recorded in `response.md` and in the pull request | **In `response.md`: yes. In a pull request: not yet** | `response.md`, "After the reviews": what was waived, by whom, the four pieces of evidence, what is not known (no phone; a switch standing in for one; Chromium only; four unexplained observations; why the browser marks early shifts), and what reopens it (a reproduction on a phone; a landing miss here with the pointer coarse and no touch emulation; the second review's third case, a device whose pointer type changes in a navigation, in parentheses). No pull request from this branch exists (GitHub's API returned none), so there is nothing to check yet: the waiver must be in its description when it is opened |

## Can the changed pass pass for the wrong reason?

| Question | Answer | Evidence, measured here unless said |
|---|---|---|
| Does it fail if the pointer is not coarse? | **Yes** | A scratch copy of `tools/audit.mjs` with the switch removed (my own edit, the same breakage as T9.audit), run on the tree's Chart preview with `--reload-only --quick`: 4 `pointer` findings (the page as opened, the page without script, both reloaded pages), exit 1. The same run shows what the guard is for: its "400 coarse" rows read 0.0000 and 0 px on a fine-pointer layout, so without the guard the pass would pass and say nothing |
| Is it the switch that makes the pointer coarse, or `isMobile`? | The switch | My probe, 400 x 900, Chart preview and fixture. `isMobile` alone: `(pointer: coarse)` false, Chart preview 7,217 px tall. Switch and `isMobile`: true, 9,659 px. Switch alone: true, 9,659 px |
| Is the layout the pass reads the one touch emulation gives? | Yes, on the two pages probed | Chart preview 9,659 px and fixture 6,538 px under both. `(any-pointer: coarse)` and `(hover: none)` match under both. They differ in `navigator.maxTouchPoints` (0 against 1) and `'ontouchstart' in window` (false against true); `dist/viz.css` has no pointer or hover media query other than `(pointer: coarse)`, and `dist/viz-chart.js` and `dist/viz-press.js` test for neither, so today the guard reads everything the layout depends on. If the system later sizes anything by `hover`, `any-pointer` or touch support, the guard must read that too |
| Does the pointer stay coarse in the document a reload replaces? | Yes, 2 of 2; and touch emulation loses it, 2 of 2 | Same probe, scrolled to the end, a recorder at `pagehide`, then a reload. Switch and `isMobile`: coarse at `pagehide`, same height, back in place (8,759 and 5,638). `hasTouch` and `isMobile`: **fine** at `pagehide`, Chart preview 8,481 px tall there and back 1,178 px short, fixture back 856 px short. This is the second review's mechanism, seen again; 1,178 px is the distance the response once reported as T3.audit's "catch" |
| Does it count entries marked `hadRecentInput`? | Yes, by the code | Not re-run by me. The author's evidence (`second-review-teeth-late-shift.txt`): a shift added on reload reads 0.0000 unmarked and 0.4400 marked at 400 px, 10 findings in each of two runs, where the shipped pass had 0 in 20 reloads. T8.audit expects the 400 px finding and is caught (`second-review-mutants-audit.txt`) |
| Can it do no reloads and pass? | **Yes. Finding c1** | Two more scratch copies of the tool, default pages, `--reload-only`. With the pass's first load of every page failing: exit 0, "System pages: 0 finding(s)", no table and no count. With no chart found (the selector renamed): the same. The code skips a page whose first load throws (`catch { continue }`) and a page with no chart, and nothing requires a number of reloads. It did not happen in any run of v9: every run printed 53 reloads on 9 pages at each layout |
| Are entries dropped? | Not that I found | The observer is installed by init script with `buffered: true` and every entry is kept with its mark; the reload is read 2 s after load. If the browser had no layout-shift entries at all the pass would read 0 silently; T8.audit would then fail in the corpus |

## My run of the reload pass (measured here)

`cd design-system && node tools/audit.mjs --reload-only --json <scratch>`, once, on the tree at HEAD (397e8b8), 23:11:39 to
23:18:04 UTC, 385 s. Playwright's `chromium_headless_shell` 157.0.8103.78 for both layouts.

| Layout | Reloads | Pages | Landed elsewhere (more than 1 px) | Moved after the jump | Largest reload shift, unmarked / marked | Largest jump shift, unmarked / marked |
|---|---|---|---|---|---|---|
| 1500 px, fine | 53 | 9 | **0 of 53** | 0 | 0.0000 / 0.0000 | 0.0000 / 0.0000 |
| 400 px, coarse in Blink, `isMobile`, no touch emulation | 53 | 9 | **0 of 53** | 0 | 0.0000 / 0.0000 | 0.0000 / 0.0000 |

0 findings, no `pointer` finding, exit 0. One reload landed 1 px away (the claims composition at 1500 px, within the tolerance,
as in the author's first run); the other 105 landed at 0 px. The same 9 pages and the same chart counts as the author's two runs
(Chart preview 10, Panel 1, reference 22, fixture 6, compositions 4, 1, 7, 1, 1).

**Machine load.** 4 cores, shared. I waited 20 minutes for the other session's `e2e/measure.cjs` to end; it runs in a chain and
did not, so the run was started with it still going (it was running at every one of the 20 samples). 1-minute load average 1.33 at the
start, 1.29 to 2.15 during (sampled every 20 s), 1.96 at the end. Layout shift and landing are judged at any load. The other
session's timing samples taken between 23:11 and 23:20 UTC shared the machine with my browser.

## The author's stated results against the evidence

| Stated in the commit or `response.md` | Evidence file | Holds? |
|---|---|---|
| `--reload-only` twice: 106 reloads, 0 of 53 elsewhere at each layout, every shift 0.0000, exit 0 | `second-review-reload-run1.json`, `-run2.json`, `-two-runs.txt` | Yes. Recomputed from the JSON: 53 and 53, 0 elsewhere, largest landing 1 px, every sum 0, no result rows. My run agrees |
| `npm run audit`: system pages 0 findings, exit 0; flows 122, reported apart | `second-review-audit-full.txt` | Yes, as printed. Not re-run (12 minutes) |
| `check.mjs` 873 of 873; `npm test` 139 pass, 0 fail, 60 skipped | `second-review-check.txt`, `second-review-npm-test.txt` | Yes, as printed. Not re-run |
| Audit mutants 48 of 48 as expected | `second-review-mutants-audit.txt` | Yes: 8 + 6 + 8 + 12 + 4 + 6 + 4. T9.audit caught by `pointer`; T8.audit not as expected against the shipped tool, which is the point. My own copy without the switch agrees with T9.audit |
| T3.audit: `reserve` kills it in 6 of 6 runs; the reloads show it in 2 of 4 runs at each layout | `second-review-t3-audit.txt` | Yes |
| Phone layout shift 0.0015 (load and run) and 0.0188 (loaded scrolled to the backtest), all from marked entries | `second-review-speed.txt` | Yes: 5 runs, p75 = median = worst |
| Desktop "Change theme (to dark)": 101 ms in a 3-run sample; 97 and 89 ms at 20 samples | `second-review-speed.txt` | Yes, and the file says more than the response does: see c5 |

## Findings

No blockers. No majors. Minors, each to be fixed or recorded as a follow-up (rubric, "After review").

- **c1. The reload pass exits 0 when it performs no reload** (found here). Rubric: Narrow and zoom names this pass as its
  measure ("as `tools/audit.mjs` does"), so a pass that can be empty is a hole in that row's guard. Shown above with two scratch
  copies. Also, `--reload-only` prints "56 pages x 14 configurations" although no configuration ran. Fix: fail when the default
  page set gives no reload at a layout; report a failed first load as `load`, as the page without script already is; add both
  breakages to the corpus.
- **c2. `tools/speed.mjs` still leaves out every marked entry after its first input, and says it leaves out only those within
  500 ms of input** (found here). Rubric: Speed, layout shift. The code trusts the browser's mark from the first input on
  (`m && t >= z.firstInput`); the second review showed that mark is also given under `isMobile` to a shift that follows a
  scroll from script, and the harness scrolls before each action. The amount is printed, so it is bounded and not hidden: on
  v9's phone run 0.0008 was left out, and 0.0015 + 0.0008 is far inside 0.05. Fix: record the times of the harness's own inputs
  and leave out only entries within 500 ms of one, or judge counted plus left out.
- **c3. `tools/shots.mjs`'s `reload` step still makes its coarse pointer by touch emulation and sums unmarked entries only**
  (the author reports it; `README.md`, "Not done yet"; `shots.mjs` lines 102 to 105). `project/README.md` now says any check
  across a navigation at the phone layout needs the audit's pointer, and the system's own imaging tool does not have it. It is a
  minor for v9, whose reload evidence is the audit's pass. It becomes a wrong image or a false 0.0000 the first time a
  coarse-pointer reload is imaged for a review: see below.
- **c4. The fixture shifts 0.0188 on the phone layout when it opens scrolled to the backtest, in every one of 5 runs, and
  nobody has looked for what moves** (the author reports it). Rubric: Narrow and zoom and Speed, layout shift under 0.05: met.
  `project/README.md` also says every region reserves its final size before its data arrives; something here does not, by a
  little. The response's earlier "0.0000 everywhere" for the phone is withdrawn by the author and is not to be quoted. The
  audit's reload pass reads 0.0000 on the fixture's six charts at 400 px; it reloads unthrottled, where the speed harness loads at
  CPU 4x and Fast 4G with the data held back, so the two do not contradict each other and the audit does not cover this case.
- **c5. The desktop theme change is at its budget, with no margin, in the author's runs of 26 November** (the author reports
  the figures). Rubric: Speed, 100 ms at the 75th percentile. The 20-sample figures are within: 97 ms with the harness as shipped,
  89 ms with the changed one, loads judged. What the response's table does not show and the evidence file does: those samples
  were taken as four blocks of 10, and two of the four printed over on their own (107 and 105 ms); 10 of the 40 samples, a
  quarter, are above 100 ms; the 3-run sample was 101. `review.md` measured the same bytes at 82 ms (20 runs) and the response
  at 81 and 72. Nothing in the system changed, and the alternating blocks show no effect of the harness change. I did not measure
  it. By the rubric this row is met on every budget-sized judged run so far, and v8's review set the precedent that a row at its
  budget with no margin is a minor. It is the weakest claim in v9: `README.md`, "Not done yet", still says every timing row is
  within budget without these figures. Measure it again at 20 runs, alternating with v8, when no other timing job shares the
  machine. A judged 20-run 75th percentile over 100 ms would be a failure of the Speed row, a blocker, and this approval does not
  cover it. On the phone's 5-run sample "Legend row toggle, 36 series" was 92 ms against 100 (worst 105): too few runs to judge.
- **c6. A chart with no reservation in its markup (T3.audit) is shown by the reload pass's own two measures in about half the
  runs** (the author reports it as a survivor). It is killed every time by `reserve`, in the same pass, so the gate holds for
  charts. What is left open: a first-frame shift that is not a chart's reservation has only the timing-dependent measure.
- **c7. `review.md`'s m1 has no follow-up recorded where the system keeps its open items.** `response.md` gives both minors
  a disposition: m2 (the rate) is answered by the second review and the rate is corrected in place; m1 (a refresh that makes
  "Colour the eight largest" appear moves what is below the chart 45 px, 0.0487 at worst against 0.05) is "not addressed by this
  change". The choice between the two fixes `review.md` offered is the lead's and is not recorded, and `README.md`, "Not done
  yet", does not list it. Its margin is 0.0013, and c4 shows the phone layout has shifts that earlier figures did not count.
- **c8. The waiver is not in a pull request yet, and the published reference was not republished** after `project/README.md`
  changed (both said by the author). Required item 4, second half; AGENTS.md, Design changes 8.

## What remains open

- **No real phone has been tested, by anyone, including me.** The waiver rests on desktop Chromium 153 and 157 with the pointer
  made coarse by a command-line switch. B1 reopens on a reproduction on a phone, or if this pass, with the pointer coarse and
  no touch emulation, sees a reload land elsewhere. In 4 runs of the changed pass (the author's three, as their evidence prints
  them, and mine on the committed tool) that is 212 reloads at 400 px, 0 elsewhere; the second reviewer's 0 of 204 is separate.
- The spike's Worker stays deployed until the owner runs the phone test or decides not to; then it is deleted and the result or
  the decision recorded in `response.md` and the spike's README.
- Why the browser marks a load's first half second of shifts as following input under `isMobile`: not established by anyone.
- c1 to c8.

## Before the system is used to review the app

Nothing in the system's CSS, tokens, components or scripts needs to change. These do:

1. **`tools/shots.mjs`'s `reload` step** gets the audit's pointer and counts every entry before any coarse-pointer reload is
   imaged or its printed shift is quoted in a review. Until then a reload at the phone layout is judged by the audit's pass, not
   by an image.
2. **The app's own harness has the same two habits** (as on disk now; another builder is editing these files and I did not
   review `app/`): `app/e2e/app.cjs` line 646 sums only unmarked layout-shift entries and its phone contexts use `hasTouch`
   with `isMobile` (lines 548, 748) with reloads nearby; `app/e2e/measure.cjs` uses `hasTouch` and `isMobile` for its phone layout
   and reports both `clsRun` (unmarked only) and `clsRunAll`. At the phone layout the unmarked sum is blind for about the first
   half second of a load, and anything read across a reload under `hasTouch` can show the emulator's miss. The app's review should
   judge the phone layout's shift on every entry given no input, and should not read a position or size across a navigation
   under touch emulation.
3. **Quote the floor as it is now measured:** the fixture's phone layout shift is 0.0015 and 0.0188, not 0.0000, and the
   desktop theme change has no margin today (c5). An app measurement "against the fixture" starts from those.
4. The waiver and its residual uncertainty go in the pull request that carries v9.

## Not checked

- A real phone; Firefox and WebKit; any Chromium but the headless shell 157.0.8103.78.
- The full audit, `check.mjs`, `npm test`, the mutant corpus and every speed scenario: read from the author's evidence, not
  re-run. I was limited to one run of the reload pass on a shared machine, plus the short scratch runs listed here.
- The layout-shift marking (`second-review-mark-probe.txt`) and the late-shift teeth: read, not re-run.
- Anything in `review.md` outside B1 and its two minors; the visual rows; the images.
- Whether the spike's Worker is live.

## Housekeeping

- The tree: this file is the only thing written. Nothing was committed, pushed or switched; git was used read-only (`log`,
  `show`, `diff --stat`, `status`, `branch --show-current`), and one read-only GitHub API call listed pull requests for the branch.
- Scratch, all under `/tmp/claude-0/-home-user-viz/3c79101e-93fd-5a8e-90a7-fca4d8b40aab/scratchpad/v9-confirm/`: the run's output
  and JSON, the load samples, the probe, and three edited copies of `tools/audit.mjs` (switch removed; first load failing; no
  chart found). The copies ran with `--root` on the tree, which they only read. No mutant touched the tree.
- One browser job of mine at a time: the reload pass (385 s), then the probe and the three copies (about 100 s in all, 23:18 to
  23:20 UTC, load 1.4 to 2.8). Each tool starts its own local server and closes it. None is running, and no browser of mine is.
- No Cloudflare resource was touched; nothing was deployed or fetched from the spike.
