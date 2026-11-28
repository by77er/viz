# Density proposal: independent judgement

Reviewer: someone who did not write the options and has not seen the author's reasoning.
Inputs read: the images in `images/`, `tasks.md`, `project/review.md`, `project/README.md`.
Nothing else was opened and nothing was run.

**Limits of this review.**
- There are no `baseline-…` files. The baseline is the left half of every `A-`, `B-` and `C-` screen image and the first column of the `all-` and `state-` images. All baseline findings come from those.
- I worked from the images only, with no running view. Hit areas, focus order, live regions and contrast ratios are **not measured**. Where a finding depends on them, it says so. I judged contrast by eye only, and nothing looked below the floors.
- There is no image of A's range or panel-command states. The `state-` images show only baseline, B and C, so A's behaviour is assumed to be the baseline's.
- No option has an image of loading, error, partial, "Showing the previous query" or "Not updating", and none shows the chart readout (task 3).

## Verdicts

| Option | Verdict | Why, in one line |
|---|---|---|
| A | **Approve** | No blockers and no majors. It also changes little: the 400 px first screens are identical to the baseline's, and at 1440 px it saves about 30 px of the first screen (3334 to 3222 px page). |
| B | **Reject (re-image), then approve with changes** | One blocker: it moves panel commands into the head where the waiting and failure words go, and that state is not imaged. Two majors: legend figures without a unit, and the range-wide figures lost from small panels. This is the direction I would merge. |
| C | **Reject** | Blocker: the panel's age moves to the page head, so a stale panel can sit under "updated just now". Error is also not imaged. Majors: the panel description is hidden (it is the only place the thresholds are said), Show earlier and Show later are hidden, legend figures have no unit, and the step and unit button's label is cut. |

## Ranking

**(1) Clarity at a glance** (can a first-time on-call person read the state from the first screen):

1. **C**. Most data on the first screen. At 1440 px (`C-services-1440-fine-light-screen.png`) it shows all four Health figures, both Traffic charts with legends, and the next section heading. At 400 px (`C-services-400-coarse-light-screen.png`) it shows two Health figures, and at Explore 400 (`C-explore-36-400-coarse-light-screen.png`) the chart is on the first screen. Two things hold it back. The thresholds that say what "bad" means are gone from the screen. The single page-level "updated just now" can be false for one panel.
2. **B**, close behind. At 1440 px (`B-services-1440-fine-light-screen.png`) it shows Health and both Traffic charts, and it keeps the descriptions ("Above 2% is worth a look; above 5% is an incident"). At 400 px (`B-services-400-coarse-light-screen.png`) it shows the first Health figure, 932 req/s, "Within thresholds".
3. **A**. About the same as the baseline. At 1440 px only the tops of the Traffic charts come into view (`A-services-1440-fine-light-screen.png`). At 400 px no figure is on the first screen (`A-services-400-coarse-light-screen.png`, the same as the baseline).
4. Baseline. At 400 px the first screen is the title and the range form, with no figure.

For a first-time person I would put B level with C. C shows more, but B tells them how to read what it shows.

**(2) Discoverability** (can they find each task's controls without hovering, guessing or being told):

1. **Baseline and A**, level. Every control is on the page, labelled with what it does.
2. **B**. The range presets and From/To are one press behind a button that shows the current range and ends in "…". Panel commands stay visible, but are labelled less clearly ("Explore").
3. **C**. The description, the text form and "Open in Explore" are behind a generic "Actions…". Show earlier and Show later are behind the range button, and Step and Unit behind a button whose label is cut.

## Tasks, option by option

"Visible" means on the screen without opening anything. "Labelled" means the control's words say what it does. "Touch" and "Keyboard" are what the images make plausible, not what was measured. The baseline is the same as A except where noted.

| # | Task | A | B | C |
|---|---|---|---|---|
| 1 | Last 6 hours | Visible "Last" segment "6 h"; one press. Touch: segment drawn full row at 400 px. Keyboard: ring shown on the segment (`state-focus-1440-fine-*`, baseline column). **Pass.** | Two presses: the range button "18 Nov, 09:30 to 12:30, 3 h, UTC…", then "6 h" in the menu (`state-range-1440-fine-light.png`, `state-range-400-coarse-light.png`; at 400 px a bottom sheet). Labelled by value, not by verb; the "…" says it opens a menu. Keyboard: ring on the button (`state-focus-1440-fine-light.png`). **Pass, one step deeper** (Words, minor: the button is not a verb). | Same as B. **Pass, one step deeper**, same minor. |
| 2 | Type an exact range | From/To fields visible and labelled. **Pass.** | From/To inside the range menu (`state-range-*`). Plausible to find once the menu has been opened for task 1. **Pass.** | Same as B. **Pass.** |
| 3 | Exact value of checkout's error rate at 09:45 | No image shows the crosshair or readout in any option, so nothing tells a newcomer that dragging or hovering the plot gives a readout. Not judgeable. Equal across options. **Not shown** (Touch parity: needs imaging). | Same. **Not shown.** | Same. **Not shown.** |
| 4 | Which service had the most errors over the range | The legend table has Last, Min and Max with the unit in the head ("Last, req/s") (baseline `…services-1440-fine-light-page.png`). Max is there; a range total or mean is only in the text form. **Pass, partly.** | The legend of small panels becomes an inline row, "checkout 0.4  catalog 2.3  auth 0.5  orders 0.5" (`B-services-1440-fine-light-screen.png`, `all-services-1440-fine-light-page.png`). It has no unit, does not say these are last values, and has no Min/Max. The person must open "Text form" for the mean. A first-timer reading the row will take catalog's 2.3 as "most", from a last value. **Fails without the text form** (Words, major). | Same inline legend (`C-services-1440-fine-light-screen.png`), and the text form is behind "Actions… → Show the text form". **Fails without two presses** (Words, major). |
| 5 | Open one panel's query in Explore | Standalone underlined link "Open in Explore" under each panel. **Pass.** | A quiet button "Explore" in the panel head (stat panels: its own line). It is visible and reachable. "Explore" repeats the navigation's "Explore" and does not say it carries this panel's query. **Pass** (Words, minor). | "Actions…" then "Open in Explore" (`state-panel-commands-1440-fine-light.png`, `…-400-coarse-light.png`: a bottom sheet at 400 px). One guess-press. **Pass, hidden one level.** |
| 6 | Read what a panel is for | The description is visible under each title. **Pass.** | Visible, under the panel commands. **Pass.** | Hidden: "Actions…" then "Show what it is for" (`state-panel-commands-*`). A first-timer has no reason to open "Actions…" to find meaning. **Fails discoverability** (Purpose, major). |
| 7 | Status from 500 to 200 | A segmented control labelled "Status", visible (`A-red-1440-fine-light-screen.png`). **Pass.** | A labelled segmented control in the toolbar (`B-red-1440-fine-light-screen.png`, `B-red-400-coarse-dark-screen.png`). **Pass.** | The same (`C-red-1440-fine-light-screen.png`, `C-red-400-coarse-dark-screen.png`). **Pass.** |
| 8 | Read the dashboard as text | "Panels / Text" segment at the top right (400 px: under the description). **Pass.** | The same segment; at 400 px it sits after the toolbar. **Pass.** | The same segment; at 400 px it sits beside the age, with "Refresh" alone on the next row (`C-services-400-coarse-light-screen.png`). **Pass** (Detail, minor). |
| 9 | Move the range one step earlier | "Show earlier", visible. **Pass.** | "Show earlier", visible beside the range button. At 400 px "Show later" wraps away from it onto the next row (`B-services-400-coarse-light-screen.png`), and in `B-red-400-coarse-dark-screen.png` "Show later" shares a row with the "Service" variable. **Pass** (Detail, minor). | Not visible: Show earlier and Show later are inside the range menu (`state-range-1440-fine-light.png`, `state-range-400-coarse-light.png`), and Explore has neither on screen (`C-explore-36-400-coarse-light-screen.png`). **Fails discoverability** (Touch parity, major: an action now needs a menu nobody would guess holds it). |

## Findings

Severity is the level the rubric gives the named row.

### Blockers

- **C-1. States and stale data, C.** In `C-services-1440-fine-light-screen.png`, `C-red-1440-fine-light-screen.png` and `C-services-400-coarse-light-screen.png`, the panel head loses "every 30 s · updated just now", and one "every 30 s · updated just now" moves to the page toolbar. The system says an age is the age of what is shown, and that after three failures *the panel head* says "Not updating". If one panel's refresh fails, the page still says "updated just now" over it. No image shows a failing or waiting panel in C. Rows: Stale data (blocker); States, error not imaged (blocker).
- **B-1. States, B.** B puts "Text form" and "Explore" into the chart panels' head row beside the age (`B-services-1440-fine-light-screen.png`, `B-red-1440-fine-light-screen.png`, "Explore…"). That row is also where "Showing the previous query" and "Not updating" must fit at a 6-column panel width and at 400 px. Neither is imaged. Row: States, error missing (blocker). The images must be made before B can be approved. I expect it to fit at 1440 px; at 400 px the head already wraps the commands onto their own line (`B-services-400-coarse-light-screen.png`).
- **B-2 and C-2. Something looks cut in the full-page phone images.** `all-red-400-coarse-light-page.png`: the B and C columns end after the "node-a" legend entry of "CPU by pod". The baseline and A show a third series, "node-b", and the "All series: job=…" line. The B and C columns at 1440 px show "node-b" on a second legend line (`all-red-1440-fine-light-page.png`). `all-services-400-coarse-light-page.png`: the B column seems to end after two rows of "Capacity by service", where the baseline has four. Either the capture stops early, or the inline legend clips its last row at 400 px. If the legend drops a series, that is the Many series row's blocker (a label missing for a series on screen). **Re-image and confirm before judging.** I have not counted it as a third blocker for B.

### Majors

- **B-3 and C-3. Words: legend figures without a unit and without saying what they are.** The inline legends in `B-services-1440-fine-light-screen.png`, `C-services-1440-fine-light-screen.png`, `B-red-1440-fine-light-screen.png` and `C-red-1440-fine-light-screen.png` read "catalog 572", "p95 795", "/orders/:id 0.31". The baseline's table head carried "Last, req/s" and "Last, ms". Rubric Words: "a number without a unit" is major.
- **B-4 and C-4. Purpose and the task: range-wide figures removed from small panels.** The baseline table's Min and Max columns are gone for panels with at most eight series (`all-services-1440-fine-light-page.png`, Traffic and Latency rows). Panels with more series keep the table ("Requests by route and status"). So "which service had the most errors over the range" (task 4) can only be answered from the plot or the text form, and the visible figure is a last value. One dashboard also gets two legend forms. Row: Purpose, single element (major).
- **C-5. Purpose: the description is hidden.** In C the description is behind "Actions… → Show what it is for" (`state-panel-commands-1440-fine-light.png`). For the Health figures it is the only element that says what the thresholds are ("Above 2% is worth a look; above 5% is an incident"; "A drop matters more than a peak"). Without it, a first-timer sees "0.40% Within thresholds" and cannot tell how close to trouble that is. Row: Purpose, single element (major).
- **C-6. Touch parity and discoverability: Show earlier and Show later are hidden.** They are in the range menu only (`state-range-1440-fine-light.png`, C column). Nothing on the C screen suggests a step control exists. In C's 1440 px range menu, "Show later" wraps alone onto a second line under "Show earlier". Row: Touch parity (major, the action exists but is not findable).
- **C-7. Words and Detail: a cut label.** "Step 15 s (auto) · unit auto…" (`C-explore-36-1440-fine-light-screen.png`) and "Step 30 s (auto) · unit auto…" (`C-explore-36-400-coarse-light-screen.png`). The unit, "per second (/s)", is not readable from the control, and "auto…" reads as a word cut off as much as a menu marker. Row: Words (major: the unit is hidden).

### Minors

- **B-5. Detail.** The quiet "Text form" and "Explore" buttons sit inset from the panel's left edge by their padding, so their words do not line up with the title and the description (`B-services-1440-fine-light-screen.png`, Health; `B-services-400-coarse-light-screen.png`).
- **B-6. Detail and grouping at 400 px.** "Show earlier" and "Show later" are split across rows (`B-services-400-coarse-light-screen.png`, `B-explore-36-400-coarse-light-screen.png`). In `B-red-400-coarse-dark-screen.png`, "Show later" shares a row with "Service", which reads as if they belong together.
- **B-7. Words.** "Explore" as a panel button repeats the navigation item and does not say what it opens. "Open in Explore", as in the baseline, is clearer for a newcomer.
- **B-8. Detail.** In `B-explore-36-400-coarse-light-screen.png`, the Unit select's arrow touches "(/s)".
- **C-8. Detail at 400 px.** "Actions…" takes a line of its own under every panel title, right-aligned, away from the title it belongs to. "Refresh" is alone on a third toolbar row (`C-services-400-coarse-light-screen.png`, `C-red-400-coarse-dark-screen.png`). Much of the height saved is given back.
- **C-9. Detail.** In `state-panel-commands-1440-fine-light.png`, C's menu opens with its right edge under "Actions…". The system anchors menus by their left edges unless there is no room. Here there seems to be room.
- **C-10. Detail.** In `C-list-1440-fine-light-screen.png`, the dashboards table's two-line intent cells sit close to the rules. Check that rows stay `row` tall.
- **All. Words.** The range button's label is the range, not a verb. I accept this, because the "…" follows the system's menu convention and the label shows the range at a glance.

### Not attributable to the options

- In the stat panels at 400 px, "Last value of … 12:30." runs straight into the threshold mark (`all-red-400-coarse-light-page.png`, baseline and A). The rule is "Never put a separator against a mark". B and C fix it by putting the mark beside the figure.

## What I would merge

**Merge B**, once it is re-imaged and these changes are made:

1. **Image the waiting and failure states with the new panel head**: "Showing the previous query", "Not updating" with a reason, and an error, at a 6-column panel width (1440 px), at 400 px coarse, and in both themes (fixes B-1).
2. **Re-take the 400 px full-page images**, and confirm that every legend lists every series and the "All series" line (B-2). If the legend clips, fix it.
3. **Give every legend figure its unit and its kind.** Either keep the head "Last, req/s" over the inline row, or write "catalog 572 req/s". Keep a range-wide figure visible for the small panels, either the baseline's Min and Max columns at 1440 px or a "max" in the row (B-3, B-4). The legend should be one form per dashboard, or the switch should follow a stated rule.
4. **Keep Show earlier and Show later together** as one wrapped group at 400 px, separate from the variables (B-6).
5. **Name the panel button "Open in Explore"**, or "Open in Explore…" when there are several queries, and align the quiet buttons' words with the panel edge (B-5, B-7). These are minors and may follow.

**From C, take:**
- The figure and its status on one line ("0.40% ▫ Within thresholds") with a short "Last value at 18 Nov 12:30." B already does this, and it fixes the baseline's mark-against-a-full-stop.
- At Explore 400 px, getting the chart onto the first screen by folding Step and Unit into one control. Take it only with a label that shows the step and the unit in full (for example "Step 30 s, automatic. Unit /s…"), and only if it does not hide Show earlier and Show later.

**From C, reject:**
- The single page-level age. It breaks per-panel staleness (C-1).
- The "Actions…" menu as the only route to the description, the text form and Explore. A first-timer will not guess it (C-5, tasks 5, 6, 8).
- Hiding Show earlier and Show later in the range menu (C-6).

**From A, take or reject:** nothing has to come from A. Its spacing changes are harmless but save almost nothing, and none of its first screens at 400 px change. If its tightened section and toolbar spacing is all done with tokens, B may take it as well. That is not needed to get B's gain.
