# Design review: the viz web app on design system v9

Reviewed 2026-11-27, 00:28 to 01:32 UTC, by an independent reviewer: an agent session that
did not write the app, the design system or `response.md`, and was not given the author's
reasoning. Findings were formed from the rubric, the images and the running app; `response.md`
and the README's "why" sections were read only afterwards, to check the author's claims
("The author's claims against what I found").

- **What was reviewed.** `app/` at commit `cc50ea2`, in a frozen worktree, built there
  (`npm run build`) and served by `vite preview` over the development mock (and a second mock
  with `--require-token` for sign-in). Views: `/explore` (start, result as chart, table, text
  and JSON with 4, 12, 36 and 200 series, empty, waiting, cancelled, stopped at 60 s, error
  with and without a result on screen, a partial answer, the API unreachable, sign-in),
  `/help`, `/settings`, the command palette.
- **Ground truth.** `design-system/project/review.md` (the rubric), `README.md`, `method.md`,
  `tokens.json`, `components/Chart/README.md`, `components/Number/README.md`; AGENTS.md,
  "Design changes"; `reviews/system-v9/confirmation.md` for the touch-emulation artifact.
- **Leads.** The 170 pairs under `compare/`. They predate the last source changes, so every
  finding below was confirmed in the running app; images cited are mine, under
  `review-images/`, unless a `compare/` name is given.
- **How.** Playwright (`chromium.launch()`, headless shell), one browser job at a time.
  Composed screens at 1500 px and 400 px (and 320 px), both themes, fine and coarse pointer
  (touch emulation, never across a reload and never with a full-page capture, which resets it),
  200% zoom as 750 and 640 CSS px. Hit areas by the design system's own page measure
  (`tools/shots.mjs`, `measurePage`, run unchanged). axe on 20 states in each theme. Speed by
  `app/e2e/measure.cjs`, unchanged.

## Verdict: reject

Three blockers and three majors (the rubric: "Reject: any blocker, or three or more majors").
The change is re-imaged and reviewed again.

What is right is most of it, and it should be said plainly: the composition holds at both
widths and in both themes, nothing scrolls sideways from 320 px up, every label on old data
stays true through a wait, a cancel, a 60 s stop and a failure, the keyboard reaches
everything with a visible ring, a finger can read the chart, and no token is broken. The
blockers are a measured budget, one control's hit area and where a reload lands. None is a
matter of taste, and two of the three are small.

### Required before the next review

1. **B1**: the result's first paint within 100 ms at 36 series (desktop) and at 200 series
   (both layouts), and chart to table within 100 ms at 200 series on the phone; or a waiver of
   this row recorded by a second reviewer (the rubric allows nothing less). With it, a complete
   before and after run of the final build, alternating, at both layouts, on a machine quiet
   enough that two runs agree.
2. **B2**: the table's "Show 50 more of 200" takes a tap over its whole 44 px.
3. **B3**: a reload lands where the page was scrolled to.
4. **M1**: the command palette can be opened on Explore without a keyboard, or the one command
   that has no other control gets one.
5. **M2**: the text form and the chart's accessible name say the day, and say that a result is
   partial when the head does.
6. **M3**: the states missing from the pairs are added to the image scenario.
7. The images made again from the final build (the author says they were not).

### May follow as recorded follow-ups

The minors (m1 to m13). m1, m2, m3 and m10 are one-line fixes and are better done now. m7, m8
and m9 are the design system's chart and need its owner.

## Blockers

### B1. A result with many series is painted late

- **Rubric:** Speed ("Are the budgets met at both layouts … and the 36- and 200-series cases
  measured?"): blocker. README, "Responsiveness and feedback": "Receives a result: paint it …
  100 ms after it arrives"; "Changes something local: chart / table / text … 100 ms"; "a figure
  measured only on a few series is not a pass".
- **What a person sees.** After the answer has arrived, the chart appears a perceptible moment
  later when the query returns a few dozen series or more: on the reference device about an
  eighth of a second at 36 series on a desktop window, and a sixth to a quarter of a second at
  200 series on either layout. On a phone with 200 series, Chart to Table is a little over
  its limit too.
- **Measured here** (75th percentile of 20 runs, median and worst in brackets; full tables
  under "Measurements"). Bold is over budget.

  | Row | Budget | Desktop 36 | Desktop 200 | Phone 36, first run | Phone 36, second run | Phone 200, first run | Phone 200, second run |
  |---|---|---|---|---|---|---|---|
  | Load at run start, median (range); calibration | | 1.3 (0.9 to 1.6); 344 ms | 1.4 (1.1 to 1.8); 344 ms | 2.8 (2.0 to 3.0); 415 ms | 2.1 (1.3 to 3.2); 351 ms | 1.8 (1.6 to 2.1); 415 ms | 2.0 (1.0 to 4.3); 363 ms |
  | Result painted, from when a copy of the body has been read (the design system's own definition of "arrives", `tools/speed.mjs`) | 100 ms | **109** (91, 131) | **143** (129, 179) | **103** (86, 170) | 65 (60, 86) | **119** (104, 167) | **117** (88, 132) |
  | Result painted, from the last byte (includes reading and parsing the body) | 100 ms | **134** (117, 165) | **237** (217, 290) | **133** (104, 213) | 78 (71, 100) | **179** (162, 235) | **170** (135, 193) |
  | Chart to table | 100 ms | 73 (57, 104) | 82 (70, 96) | **121** (101, 216) | 88 (82, 99) | **122** (109, 184) | **114** (96, 162) |
  | Crosshair: move to the next frame | 50 ms | 30 (30, 32) | 30 (29, 33) | **58** (55, 62) | 47 (47, 52) | **56** (52, 62) | **51** (48, 58) |
  | Legend row chosen | 100 ms | 37 (34, 53) | 43 (37, 64) | **104** (86, 140) | 62 (57, 82) | 91 (68, 132) | 66 (63, 94) |

  Every run was judged by the README's rule (load at the start of the run at or below 4
  cores), except 2 of the 20 in the second phone run at 200 series.

- **What these runs establish, and what they do not.**
  - *Established.* The result's first paint at 200 series is over at both layouts, by both
    definitions, in every run (117 to 237 ms). At 36 series on the desktop it is over from the
    last byte (134 ms; the author's three runs of this row read 111, 119 and 130) and marginal
    by the system's definition (109 ms, median 91; the author's read 98, 85 and 83). Chart to
    table at 200 series on the phone is over in both runs (122 and 114 ms).
  - *Not established.* Everything at 36 series on the phone. The first run put five rows
    over; the second, forty minutes later with another session's work lighter on the machine,
    put every row inside, most of them by a wide margin (78 ms against 133). I take the second
    as the truer one and do not count the phone's 36-series rows against the change. The
    crosshair at 200 series on the phone read 56 and 51 ms against 50: at its limit, not
    judged by me either way.
  - *About the rule.* Both phone runs at 36 series were "judged" by the README's rule, and one
    of them was wrong by 70%. A load of 3 on 4 cores is inside the rule and moved a 78 ms row
    to 133 ms. On this machine "load at or below the core count" is too loose to tell a pass
    from a fail for a row within half of its limit; I would not accept a thin-margin row,
    from the author or from myself, that was not measured twice.
- **Where.** `/explore`, chart form, both themes (colour does not enter), 1440 x 900 fine
  pointer and 400 x 800 touch, CPU 4x, Fast 4G.
- **Does a typical result meet the budget?** Yes. The author's own sentence is someone on call
  asking a metrics question; the queries the start state offers return 1, 3, 4, 4 and 12
  series, and an aggregated query (`sum by (service)`) is the common case. Measured here:
  4 series, 45 ms (41, 73) desktop and 50 ms (46, 80) phone by the system's definition, 55 and
  64 ms from the last byte; 12 series (`pod_memory_working_set_bytes`, the largest of the start
  state's examples), 82 ms (73, 108) desktop and 64 ms (53, 81) phone, 88 and 74 ms from the
  last byte. So the common result is inside the budget, with little to spare at a dozen series
  on a desktop window, and the many-series result is not. The README does not let the first
  stand in for the second ("a figure measured only on a few series is not a pass"), and 36
  series is one `sum by (service, route, status)` away, which is what a person narrowing down
  an incident types next.
- **Severity, as the rubric defines it.** The Speed row has one level, blocker, and no "else".
  I did not find a reading of the rubric under which a 75th percentile of 117 to 237 ms
  against 100, seen in every run at 200 series, passes. How much it matters is a fair
  question (from the press to the paint is 0.5 to 1.8 s on the reference link, nearly all of
  it the network, and the common result is inside); the rubric gives that question to a second
  reviewer, not to me.
- **Also failing in this row, as evidence rather than as speed:** no before and after of the
  final build in one session, alternating (rubric, and "What the author provides", 6). The
  author says so. I measured "after" only; I did not build the app before the change.
- **Smallest change that would resolve it.** This one is engineering, not styling. The budget
  row itself names the way out: "coarse data first, refined in place". Paint the plot (eight
  lines and the band) inside 100 ms and let the legend's figures, the text form and the
  table's rows follow; or ask for fewer points than 721 per series when there are 200 series
  (3.6 MB of JSON for one chart about 1,400 px wide). If the cost is the design system's SVG
  chart on a result this size, as the author says, then it is a change to the system in the
  same pull request (AGENTS.md, Design changes, 8) or a waiver by a second reviewer that says
  what is accepted, for which sizes, and until when. A waiver is not mine to give.

### B2. "Show 50 more of 200" under the table takes a tap on 34.5 px, not 44

- **Rubric:** Touch ("With a coarse pointer, does every control have a 44px hit area with no
  overlap"): blocker.
- **What a person sees.** In the table form of a result with more than 50 series, the button
  that shows the next 50 sits directly under the last row. Its drawn box is 24 px tall and it
  declares a 44 px area centred on it, but the upper 9.5 px of that area lie under the table's
  last row, which takes the tap. Taps 13, 16 and 20 px above the button's centre did nothing, at
  400 and at 320 px (six taps); a tap 20 px below it showed the next 50 rows.
- **Where.** `/explore?…&view=table` with 200 series, coarse pointer, 400, 320 and 1500 px,
  both themes. Measured by `tools/shots.mjs` `measurePage`: "Show 50 more of 200" 148.8 x 34.5.
  The pairs do not show it: `compare/app-v9-touch-table-*` has 36 series and so no button.
- **Image:** `review-images/B2-table-more-hit-area-400-coarse-light.png`,
  `review-images/B2-table-more-1500-coarse-light.png`.
- **Smallest change.** Keep the row of controls clear of the table above it with a coarse
  pointer, as the README requires of a row of controls over a plot or table ("a row of controls
  in a panel keeps a small button's hit area off the plot or table under it"; here the table
  is above). `ResultTable.tsx` puts a bare `vz-controls` straight after `vz-table-wrap`;
  `vz-stack`, or the system's spacing for a control row in a panel, gives the 10 px. Add a
  200-series table to the coarse `measure` scenario so the check that found this runs for the
  author too.
- **Same row, the design system's component, 1 px:** at 1500 px with a coarse pointer the
  legend's "Min" sort head measures 43 x 44.8 (`measurePage`, both themes). The app does not
  draw it. It is recorded here so the system's owner sees it; it would not block on its own
  account in my judgement, but the rubric's row is the same one.

### B3. A reload throws the reader back to the top of the page

- **Rubric:** Narrow and zoom ("… layout shift under 0.05 when the page loads scrolled to a
  region (reloaded scrolled to each chart, as `tools/audit.mjs` does, and landing where it
  was)"): blocker. README: "Keep focus and scroll position where they were"; the audit "fails
  … a chart that does not land where it was (v9; the v8 review's B1)".
- **What a person sees.** At 400 px the result begins about 800 px down the page, below the
  whole form. Someone reading the chart who reloads (or whose phone reloads the tab for them
  after it was put aside) is shown the top of the page: the banner, the query, the fields. The
  chart they were looking at is two screens down again. Nothing shifts (layout shift 0.0000);
  the page simply is not where it was.
- **Measured here, with a control, and not under touch emulation.** Fine pointer, plain
  Chromium, 1500 and 400 px wide. A static page 4,000 px tall, scrolled to 1,500 px and
  reloaded in the same browser: back at 1,500 px. The app, in seven cases (Explore with 36
  series, on the mock without a key and signed in on the mock that needs one; the table of
  200; Help, which has no data; at both widths): scrolled to between 338 and 807 px, after
  the reload at 0 px in every case, with no scroll event in the 3 s after. The reason is in
  the same trace: at the browser's `load` event the document is 700 px tall, the height of
  the window, because the app has drawn nothing yet; the browser has nowhere to restore to,
  and the app does not restore the position itself. This is not the tool artifact recorded in
  `system-v9/second-review.md` (no `hasTouch`, the landing is exactly 0 every time, and the
  control lands).
- **Where.** `/explore` (every form of the result) and `/help`, both widths; it costs most at
  400 px, where the result is below the first screen.
- **Image:** `review-images/B3-reload-lands-at-the-top-400-light.png`.
- **Not checked by the author.** `e2e/app.cjs` checks that a reload reserves the chart's
  height to the pixel; nothing checks where the reload lands. The reservation is what makes
  the fix cheap.
- **Smallest change.** Restore the position once the reserved layout is drawn: the router's
  scroll restoration, or the scroll offset kept in `sessionStorage` at `pagehide` and applied
  in the first frame that has the page's reserved height (the chart's height is already
  remembered there). Then a check at both layouts, with the pointer made coarse the audit's
  way for the phone layout, not by touch emulation.

## Majors

### M1. On Explore the command palette opens only with Ctrl or Cmd K, and "Copy a link to this view" exists nowhere else

- **Rubric:** Touch parity ("Can a finger do everything a pointer and a keyboard can: no
  modifier keys …"): "blocker for a missing action, else major". Judged major: the action a
  finger lacks is copying the address, which the browser's own address bar still gives, so no
  capability of the product is lost; a second reader may fairly call it a missing action and a
  blocker. The verdict does not turn on it.
- **What a person sees.** The navigation no longer has "Commands". On Explore nothing on
  screen opens the palette; it opens with a modifier key a phone lacks. Help has a button
  "Open the command palette", but the palette opened there lists only navigation, theme and
  sign-out: Explore's commands are registered only while Explore is the page. Of those, every
  one has a control on the page except "Copy a link to this view". A mouse-only user is in
  the same position as a finger.
- **Where.** `/explore`, every width and pointer; `/help` for the button.
- **Images:** `review-images/M1-explore-400-no-way-to-open-commands.png`,
  `review-images/M1-palette-opened-from-help-has-no-explore-commands.png`.
- **Smallest change.** Either drop "Copy a link to this view" (Help already says the address
  bar is the link) or give it a small button; and say on Help that the palette's Explore
  commands appear on Explore. If the palette is meant to be a keyboard accelerator only,
  that is then true of every command in it.

### M2. The text form and the chart's accessible name leave out the day, and do not say when a result is partial

- **Rubric:** Text form ("Does the digest carry the same information as the visual form?"):
  major. (Words, "a result that hides that it is partial", is the same failure seen from the
  other side; one finding.)
- **What a person sees.** The head says "18 Nov, 09:30 to 12:30 · every 15 s". The text form,
  offered "for reading aloud, for copying, for an agent", begins "Query result: sum by
  (service, route, status) (…), /s, 09:30 to 12:30, one value every 15 s." The chart's
  accessible name says the same. Pasted into an incident note nine days later, the text does
  not say which day. And when the API sends a warning, the head shows a banner ("The API sent
  a warning with this result, so it may be incomplete: …") while the text form says nothing of
  it: the copy reads as a whole result.
- **Where.** `/explore?…&view=text` and the chart's `aria-label`, any width and theme, any
  range not on today's date; the warning with `GET /__mock/warn`.
- **Image:** `review-images/M2-text-form-has-no-date-1500-light.png`; the banner in
  `review-images/M3-states-not-in-the-pairs-partial-10s-60s-unreachable-1500-light.png`.
- **Smallest change.** The app already rewrites the text form's first line and the plot's name
  (`charts/fixups.ts`): put the head's day prefix there too, and add a line for warnings
  ("The API sent a warning: …; the result may be incomplete"). Better in the design system's
  `textLines`, which then needs the date in the spec.

### M3. Five designed states are not in the images

- **Rubric:** States ("Are loading, empty, error, partial, hover, focus, pressed, busy and
  disabled designed and imaged?"): "blocker if focus or error is missing, else major". Focus
  and error are imaged; these are not: a partial answer (the warnings banner), the 10 s row of
  the waiting table (the cheaper alternative), the 60 s stop, the busy answer being retried
  ("The API is busy (HTTP 503). Asking again in 1 s."), and the API unreachable (the error
  state, and the sign-in form's "The API did not answer").
- **What I did about it.** I made them and judged them: all five are designed, true and
  composed correctly at 1500 and 400 px (the 10 s line wraps to two lines inside the 44 px
  strip on a phone and both its controls measure 44 px). So nothing in the app needs to change
  for this finding. The level is the rubric's; what is missing is the author's evidence, and
  the next reviewer should not have to make it.
- **Images:** `review-images/M3-states-not-in-the-pairs-partial-10s-60s-unreachable-1500-light.png`,
  `review-images/M3-states-not-in-the-pairs-10s-60s-partial-400-coarse-light.png`,
  `review-images/pass-waiting-cancelled-busy-1500-light.png` (the busy line is its fifth strip).
- **Smallest change.** Five more states in `app/e2e/v9-shots.cjs`.

## Minors

Each may be fixed or recorded as a follow-up.

| # | Rubric row | What a person sees | Where | Image | Smallest change |
|---|---|---|---|---|---|
| m1 | Detail | The head of an empty result reads "18 Nov, · every 15 s · updated just now": the range is written by the chart and there is none | `/explore`, no series matched; every width and theme; also in `compare/app-v9-empty-*` | `m1-empty-head-range-missing-1500-light.png` | Write the range in the head when no chart is drawn |
| m2 | Words | The empty Step field shows "30 s" in the mono of a value, over "Empty: automatic, now 15 s." The example reads as the step | `/explore`, desktop (at 400 px the automatic step happens to be 30 s) | `m2-step-placeholder-30s-beside-now-15s-1500-light.png` | No placeholder, or the automatic step itself as the placeholder |
| m3 | Keyboard | In the palette, Tab moves the ring from the field to the list (the browser makes a scroller a tab stop); there the highlighted command stays highlighted and the arrow keys and Enter do nothing | palette, both themes | `m3-palette-after-tab-1500-light.png` | `tabIndex={-1}` on the list |
| m4 | Feedback | "Copy a link to this view" closes the palette and nothing says whether the address was copied; a refusal by the browser is swallowed. The palette's placeholder "last 24 h" names a command that Help and Settings do not have | palette | (none) | Say "Copied" where focus returns, as the two Copy buttons do; a placeholder that is not a command, or none |
| m5 | Type (one precision per column) against principle 1 | The table gives 15 of 36 rows as "< 1": 0.68 /s and 0.014 /s read the same. It takes the chart's number format; the before-image had three figures. Sorting still uses the real values | `/explore?…&view=table`, 36 series | `m5-table-36-values-below-1-400-light.png` | The table's own precision from its own smallest value, or two significant figures; a decision for the system's Number rules |
| m6 | States | After a failure the chart form keeps the previous result's figures under the message, with "Showing the previous query"; Table, Text and JSON show the message alone, the head loses its meta, and the Unit select turns to the failed query's unit (it stays the old result's in the chart form) | `/explore`, a query that fails after a result | `m6-failed-after-a-result-chart-then-table-1500-light.png` | Keep the previous table under the message as the legend is kept, or say in the head that nothing of the previous result is shown; one rule for the Unit select |
| m7 | Detail (truncation hides what distinguishes) | At 320 px the legend drops the third label for every row, so with Other open three rows read "/product · catalog" and three "/cart · checkout"; a finger has no title to consult. Also at 320 px: an empty band about 60 px tall under "Show earlier" (the kept place of "Query the chart's range" wraps to its own row), and the tenant's name breaks in the navigation | `/explore`, 36 series, 320 px | `m7-legend-320-names-repeat.png`, `m7-320-gap-and-tenant-wrap.png` | The design system's Chart, "Names", rule 4: never drop a label that is the only difference between two listed rows; in the app, do not keep the place of the third button below `breakpoint-narrow` |
| m8 | Many series | Once Other is opened it cannot be closed until every member is listed: with 200 series, ten presses and a page 5,800 px tall before "Hide the 192 in Other" appears | `/explore`, 200 series | (none) | The design system's chart: offer "Hide" beside "Show 20 more" |
| m9 | Many series (Chart, "Series colour", 2) | The same address gives a different picture in a tab that ran another query first: the four largest series are dashed and the legend opens with the fifth largest. The algorithm is followed (free slots first); the link does not carry the map, as the system says it should. The author lists this as not done | `/explore`, 36 series after a 4-series query | `m9-same-address-fresh-tab-then-after-a-4-series-query-1500-light.png` | Carry the ordered keys in the address; and a question for the system's owner: Explore runs unrelated queries in one view all day, so "free slots first" puts the largest series in the dashed slots most of the time |
| m10 | Words | A checkbox labelled with a statement, "The key is shown as typed", unchecked while the key is shown as dots | sign-in | `m10-sign-in-checkbox-label-1500-light.png` | "Show the key" |
| m11 | Words | A range across midnight reads "18:49 to 00:49" in the head with no day; the field's help line beside it has both days | `/explore`, "now - 6 h" shortly after midnight | `m11-range-across-midnight-head-1500-light.png` | The day on both ends when they differ |
| m12 | Feedback (README, "Offline or stalled") | When a query finds the API unreachable the error state says so and offers "Run the query again"; no banner at the top of the page and nothing asks again by itself. The banner exists but hangs on the build-information probe, which is asked once in five minutes | `/explore`, network gone after load | `M3-states-not-in-the-pairs-partial-10s-60s-unreachable-1500-light.png`, fourth strip | Let a query's network failure raise the same banner and the same 10 s retry |
| m13 | Narrow and zoom (evidence) | Fields are 15 px with a coarse pointer (the system's `body`); iOS zooms a focused field under 16 px. The author lists it; nobody has tried a device | sign-in, From, To, Step, the query | (none) | A device test; then the system's decision |

## What holds, row by row

| Rubric row | Result | On what evidence (measured or seen here) |
|---|---|---|
| Purpose | Pass, with M1 | The presence-test table has an answer for each element; "every command has a control" is not true of one command (M1) |
| Tokens | Pass | `npm run check:tokens`: "contrast and structure: 759/759 checks pass; literal values: 0 in 58 file(s)". `app.css` read: 18 rules (the response counts 12), every value a token or a whole-number multiple of one. The two `style=` attributes carry only the chart's reserved-height custom properties, as the system prescribes |
| Colour | Pass | One blue button per view (Run query; Sign in on the form); status marks with words; no colour outside buttons, marks and the chart in any state imaged |
| Contrast | Pass as far as I measured | axe (which includes text contrast): 0 violations on 20 states x 2 themes at 1500 px and 13 states at 400 px (light). Series on each surface: not measured by me; the system's check covers the pairings |
| Type | Pass | Numbers in mono, right-aligned, unit once in the head; no capitals, no tracking. m5 is the precision, not the face |
| Hierarchy | Pass | `compare/app-v9-greyscale-*`: plot, legend, then the head |
| States | **M3** | Focus, error, empty, waiting, pressed, chosen, disabled are designed and imaged; five are designed and were not imaged |
| Keyboard | Pass | 30 tab stops on Explore with 36 series, in reading order, a ring computed and seen on each (the editor's by its well, a legend row's by its cells), none clipped, none off screen; the legend is one stop with arrow keys and Space (a segmented control is still one stop per segment, as the author says); the plot reads values by arrow keys; Cancel hands focus to Retry; the palette returns focus where it was. `review-images/pass-focus-rings-1500-light.png`. m3 |
| Screen reader | Pass on structure; not heard | axe 0 violations; names and roles on every control; the waiting line is a status whose elapsed time is hidden from it; the readout speaks 500 ms after the pointer rests |
| Speed | **B1** | "Measurements" |
| Feedback | Pass, with m4 and m12 | No bar, no skeleton, no spinner; the waiting table's rows appear at 0.4, 2, 10 and 60 s as written; nothing waits on a local change (watched with 200 series) |
| Stale data | Pass | While another query waited (0.25, 1.2 and 2.8 s), after Cancel, after the 60 s stop and after a failure: the title, the query line, the range, the step, the age, the unit select, the legend's unit, the plot's name and the text form all stayed the previous result's, under "Showing the previous query" (or "… time range" when only the range changed) |
| Consistency | Pass | The legend, the readout, the table and the text form give one value for one figure |
| Agent content | Not applicable | No agent text in these views |
| Touch | **B2** | Every other control measured 44 px with no overlap at 400, 320 and 1500 px coarse, in 17 states |
| Touch parity | **M1** | Legend by tap, crosshair by drag with the readout under the plot, zoom by buttons, Cancel and Retry by tap, the palette closed by a tap outside: all work (`review-images/pass-touch-crosshair-waiting-cancelled-400.png`) |
| Narrow and zoom | **B3**; the rest passes | No sideways scroll and no text under 11 px at 320, 400, 640 and 750 CSS px. Layout shift on load, every entry: 0.0000 at both layouts (20 runs each of 4, 12, 36 and 200 series). **B3** is this row's last clause: a reload does not land where it was |
| Reduced motion | Pass | With reduced motion requested nothing on Explore or the open palette has a transition or an animation |
| Text form | **M2** | |
| Charts | Pass | Zero on the axis, unit once, step in the head, the time axis ends at the range's end, direct labels with leaders or none, slots 5 to 8 dashed |
| Many series | Pass on the algorithm | A round trip to a query with no shared series returned every colour; toggles moved none; a narrowing coloured the eight largest left; after a narrowing and a round trip Other held larger series, the note said "17 in Other are now larger than a coloured series" and "Colour the eight largest" was offered, and only then; the readout's nearest named a member of Other. m7, m8, m9 |
| Words | Pass, with m2, m10, m11 | |
| Detail | m1, m7 | |
| System | Pass | No new token or component class. The app's own CSS and its five rewrites of what the chart writes are listed with their reasons in the response, as the row asks. The palette places its dialog with a margin of its own (`dialog.palette`), listed. Whether `design-system/` differs from the reviewed v9: not diffed |

## Measurements

All **measured here**: Chromium headless shell under Playwright, CPU slowed 4x, Fast 4G, the
development mock on localhost, a fresh context per run, `app/e2e/measure.cjs` as committed, on
the built app of commit `cc50ea2`. 4 cores, shared machine. Each cell is the 75th percentile of
20 runs, then (median, worst). Every run was judged (load at the start of the run at or below
4) except two of the last table but one. "After" only: no "before" build was measured, so these are budget
figures, not a comparison. Bold is over budget.

**Desktop, 1440 x 900, fine pointer.** 00:30 to 00:44 UTC. Calibration 344 ms.

| What | Budget | 4 series | 36 series | 200 series |
|---|---|---|---|---|
| Load at run start, median (range) | | 1.2 (0.9 to 1.4) | 1.3 (0.9 to 1.6) | 1.4 (1.1 to 1.8) |
| Press on Run query to the pressed frame | 50 ms | 13 (12, 19) | 16 (11, 28) | 13 (12, 16) |
| Click on Run query to the busy state | 100 ms | 31 (28, 38) | 42 (33, 51) | 31 (27, 39) |
| Typing, 75th percentile of a run's 60 keys | 50 ms | 24 (22, 26) | 22 (21, 25) | 24 (23, 30) |
| Typing, slowest key of a run (not a budget figure) | | 46 (38, 57) | 44 (37, 52) | 42 (39, 113) |
| Crosshair | 50 ms | 28 (27, 30) | 30 (30, 32) | 30 (29, 33) |
| Chart to table | 100 ms | 38 (36, 76) | 73 (57, 104) | 82 (70, 96) |
| Table to text | 100 ms | 28 (25, 36) | 33 (26, 43) | 30 (25, 43) |
| Text to chart | 100 ms | 33 (31, 37) | 30 (27, 42) | 31 (26, 46) |
| Legend row chosen | 100 ms | 54 (42, 67) | 37 (34, 53) | 43 (37, 64) |
| Result painted, after a copy of the body was read | 100 ms | 45 (41, 73) | **109** (91, 131) | **143** (129, 179) |
| Result painted, from the last byte | 100 ms | 55 (49, 83) | **134** (117, 165) | **237** (217, 290) |
| Worst interaction (Event Timing), whole run | 200 ms | 72 (64, 88) | 80 (80, 112) | 80 (72, 112) |
| Layout shift, first load, every entry | 0.05 | 0.0000 | 0.0000 | 0.0000 |
| Layout shift, query run, every entry | 0.05 | 0.0000 | 0.0000 | 0.0000 |

**Phone, 400 x 800, coarse pointer, touch, device scale 2.** 00:54 to 01:09 UTC. Calibration
415 ms: the machine was about a fifth slower than during the desktop runs, with another
session's work on it. By the README's rule these runs are judged (load never above 4) and the
calibration is context only. The second runs of the 36- and 200-series cases, in the next
table, show how much that load cost: read this table's 36-series column with them.

| What | Budget | 4 series | 36 series | 200 series |
|---|---|---|---|---|
| Load at run start, median (range) | | 2.9 (0.8 to 3.5) | 2.8 (2.0 to 3.0) | 1.8 (1.6 to 2.1) |
| Press on Run query to the pressed frame | 50 ms | 20 (17, 27) | 24 (21, 36) | 24 (21, 40) |
| Tap on Run query to the busy state | 100 ms | 59 (48, 87) | 67 (57, 116) | 66 (53, 82) |
| Typing, 75th percentile of a run's 60 keys | 50 ms | 33 (29, 43) | 43 (36, 58) | 35 (32, 39) |
| Typing, slowest key of a run (not a budget figure) | | 61 (46, 231) | 86 (68, 245) | 56 (53, 69) |
| Crosshair | 50 ms | 49 (48, 52) | **58** (55, 62) | **56** (52, 62) |
| Chart to table | 100 ms | 80 (65, 116) | **121** (101, 216) | **122** (109, 184) |
| Table to text | 100 ms | 50 (46, 68) | 68 (55, 80) | 64 (54, 87) |
| Text to chart | 100 ms | 55 (46, 67) | 61 (58, 99) | 58 (50, 76) |
| Legend row chosen | 100 ms | 76 (59, 129) | **104** (86, 140) | 91 (68, 132) |
| Result painted, after a copy of the body was read | 100 ms | 50 (46, 80) | **103** (86, 170) | **119** (104, 167) |
| Result painted, from the last byte | 100 ms | 64 (58, 98) | **133** (104, 213) | **179** (162, 235) |
| Worst interaction (Event Timing), whole run | 200 ms | 88 (72, 224) | 144 (104, 232) | 120 (112, 184) |
| Layout shift, first load, every entry | 0.05 | 0.0000 | 0.0000 | 0.0000 |
| Layout shift, query run, every entry | 0.05 | 0.0000 | 0.0000 | 0.0000 |

**Phone again, the two many-series cases.** 36 series 01:16 to 01:21 UTC (calibration 351 ms,
20 of 20 runs judged); 200 series 01:22 to 01:27 UTC (calibration 363 ms, 18 of 20 judged: the
load passed 4 in the last runs).

| What | Budget | 36 series, second run | 200 series, second run |
|---|---|---|---|
| Load at run start, median (range) | | 2.1 (1.3 to 3.2) | 2.0 (1.0 to 4.3) |
| Press on Run query to the pressed frame | 50 ms | 20 (18, 28) | 22 (18, 32) |
| Tap on Run query to the busy state | 100 ms | 50 (47, 67) | 59 (50, 68) |
| Typing, 75th percentile of a run's 60 keys | 50 ms | 26 (25, 28) | 30 (28, 33) |
| Crosshair | 50 ms | 47 (47, 52) | **51** (48, 58) |
| Chart to table | 100 ms | 88 (82, 99) | **114** (96, 162) |
| Table to text | 100 ms | 52 (48, 57) | 57 (49, 69) |
| Text to chart | 100 ms | 52 (50, 60) | 52 (51, 72) |
| Legend row chosen | 100 ms | 62 (57, 82) | 66 (63, 94) |
| Result painted, after a copy of the body was read | 100 ms | 65 (60, 86) | **117** (88, 132) |
| Result painted, from the last byte | 100 ms | 78 (71, 100) | **170** (135, 193) |
| Worst interaction (Event Timing), whole run | 200 ms | 88 (80, 96) | 112 (96, 160) |
| Layout shift, first load and query run, every entry | 0.05 | 0.0000 | 0.0000 |

**A typical result, 12 series** (`pod_memory_working_set_bytes`; a copy of the harness with
this one case added, typing and crosshair skipped). 01:12 to 01:17 UTC.

| What | Budget | Desktop | Phone |
|---|---|---|---|
| Load at run start, median (range); calibration | | 2.2 (1.6 to 3.3); 353 ms | 2.3 (1.6 to 3.0); 334 ms |
| Chart to table | 100 ms | 51 (49, 77) | 75 (67, 90) |
| Table to text | 100 ms | 30 (26, 38) | 50 (48, 63) |
| Text to chart | 100 ms | 31 (28, 45) | 58 (48, 67) |
| Legend row chosen | 100 ms | 35 (32, 80) | 63 (56, 68) |
| Result painted, after a copy of the body was read | 100 ms | 82 (73, 108) | 64 (53, 81) |
| Result painted, from the last byte | 100 ms | 88 (83, 124) | 74 (59, 91) |
| Layout shift, first load and query run, every entry | 0.05 | 0.0000 | 0.0000 |

**Script, as built** (from the harness's byte count): 146 KB of compressed script in the
first chunk, against the shell's 200 KB; the query editor is a second chunk of 142 KB that
Explore fetches at once. Stylesheet 10 KB compressed, two fonts 129 KB.

**Rows I measured:** every row above, at both layouts, at 4, 36 and 200 series, 20 runs each;
the phone's 36- and 200-series cases twice; a 12-series case without typing and crosshair.
**Rows I did not measure:** anything "before"; a change of theme; opening the palette;
moving between Explore, Help and Settings; a typed step that asks for more samples than
pixels; the real API; a device.

## The author's claims against what I found

Read after the findings were written.

| Claim (`response.md`) | Holds? |
|---|---|
| "Not met: a result's first paint with many series" (36 series 111 to 119 ms, 200 series 244 to 262 ms from the last byte) | Yes, and a little worse here: 134 and 237 ms on the desktop |
| The same row "within" at 36 series by the harness's copy (85 and 83 ms) | Not on my runs: 109 ms (median 91) desktop, 103 ms phone. Marginal either way |
| The phone layout of the final build is not measured | Measured here, the many-series cases twice. At 200 series the first paint and chart to table are over; at 36 series nothing is established as over |
| Layout shift on a reload with the reserved height is checked | The shift, yes (0.0000 here too). Where the reload lands is not checked, and it lands at the top (B3) |
| No complete before and after of the final build | True, and still true: I measured after only |
| "Removed by the test: the Commands button … (every command has a control …)" | No: "Copy a link to this view" has none (M1) |
| B1 of the first review (old data under new labels) fixed and verified | Yes; I could not make a label lie in any of six situations |
| B2 of the first review (the query well's touch size) fixed | Yes: the well is 44 px and a tap anywhere in it reaches the editor (the system's measure reports the inner editor as 22.8 px tall, which is its box and not what a finger gets) |
| Touch: "44 px hit areas" everywhere | One exception, B2 here |
| Images not made again after the last source changes | True; my images are from the final build |
| A shared link does not carry the colour map | True (m9) |
| The 10 s and 60 s waits checked, not imaged | True; imaged here (M3) |
| 130 checks in `e2e/app.cjs`, all passing; the mutants | Not run by me |

## What I did not check

- A "before" build, so no regression figure of my own.
- A real phone, Safari, Firefox, a screen reader by ear, enlarged text as distinct from zoom.
- A reload scrolled to the chart with a coarse pointer. Touch emulation cannot test it
  (`system-v9/confirmation.md`) and I was limited to a plain `chromium.launch()`; B3 is
  measured with a fine pointer at both widths, where the layout is the phone's but the
  controls are not at their touch sizes.
- The app on the real viz API (`e2e/real.cjs`), the deployed gateway, the content security
  policy run (`e2e/prod.cjs`), the unit tests, `e2e/app.cjs`, the mutants.
- Series colours against each surface, and the design system's own audit: taken from the
  system's review.
- Whether `design-system/` differs from the reviewed v9: not diffed.
- A window across a clock change; a result with more samples than pixel columns; the
  key-check wait ("Asking the API who this tab's key is"); the page error boundary.
- Hover fills and pressed fills on every control: seen on Run query (pressed by a held finger:
  `data-pressed`, the darker blue) and legend rows only.

## Housekeeping

- Written by me in the repository: this file and `review-images/` (21 PNG files, under 1 MB).
  Nothing else. No commit, no push, no deploy, no Cloudflare call; git read-only. While I
  worked, another session's commit (`fc82aa8`, "Work in progress: parallel component build")
  took 16 of those images in with its snapshot; that commit is not mine.
- The frozen worktree: built there (`dist/`, and the design system's `dist/` generated by the
  app's prebuild); my measurement files are `app/e2e/measurements/rv*.json` in that worktree,
  not in the repository.
- Servers I started (two mocks, two previews, and the harness's own) are stopped. One browser
  job at a time throughout.
