# Review: flow screens v1

Reviewed from `flows/shots/` (24 images), the built pages in `dist/flows/`, and my own renders: dark at 400 px, greyscale at 1440, coarse pointer at 400, 200% zoom (720 px CSS viewport at 2x) and 320 px. Hit areas, overflow and contrast are measured from the built pages, not estimated. `check.mjs` was not run on the screens. The existing `dist/` build was used as found (it is newer than every source file).

Images beside this file:

| File | Shows |
|---|---|
| `4-monitor-grey-1440.png` | Monitor in greyscale: the state line is the weakest thing in the header |
| `6-investigation-grey-1440.png` | Investigation in greyscale: button and banner outrank the first claim; series indistinguishable |
| `2-dashboard-grey-1440.png` | Dashboard in greyscale: three series cannot be told apart |
| `3-monitors-coarse-400-hitareas.png` | Coarse pointer, measured hit areas: links 18–20 px, segmented and button overlapping |
| `4-monitor-coarse-400-hitareas.png` | Same for Monitor: Acknowledge and Silence 8 px apart, Related links 20 px |
| `4-monitor-dark-400.png` | The night view: the yellow Silence button is the brightest thing on the page |
| `3-monitors-zoom200.png` | 200% zoom: Notifies and Investigation columns off screen |
| `5-new-monitor-light-1440.png` | The backtest chart contradicting its own sentence |

## Verdict

**Reject.** Six blockers and more than three majors (rubric: any blocker, or three or more majors). Re-image and review again.

| Screen | Verdict | Deciding findings |
|---|---|---|
| 1 Dashboards | Reject | B1, B6; M8 |
| 2 Dashboard | Reject | B1, B5, B6; M6, M7 |
| 3 Monitors | Reject | B1, B2, B3, B6; M10 |
| 4 Monitor | Reject | B1, B3, B6; M1, M2, M6 |
| 5 New monitor | Reject | B2, B4, B6; M11 |
| 6 Investigation | Reject | B1, B5, B6; M3, M4 |
| 7 Proposed change | Reject | B6; M5 |
| 8 Keys | Reject | B1, B6; M9 |

No screen scrolls the page sideways at 400, 320 or 200% zoom, and no text is below `micro` (11 px). Text contrast passes everywhere (lowest: `ink-muted` on `ground`, 5.33:1 light, 5.79:1 dark). One blue button per screen holds.

## Blockers

**B1. Links have an 18–20 px hit area with a coarse pointer.** Screens 1, 2, 3, 4, 6, 8. Image `3-monitors-coarse-400-hitareas.png`, `4-monitor-coarse-400-hitareas.png`. Rule: "With a coarse pointer every control has a `control-touch` hit area"; rubric Touch. Measured: 30 links, all 18 or 20 px tall; the coarse-pointer block in `viz.css` extends buttons, segments, tabs, nav and checkboxes but not `.vz-link`. These links are the main path of flows 2, 3, 4 and 6: the dashboard and monitor names, "Open the monitor", "2 likely causes", "Open in Explore", "Manage". In tables the rows are 32 px, so 44 px areas on adjacent row links would overlap by 12 px; the three Related links on Monitor would overlap by 16 px.
Change (system): with a coarse pointer, table rows become `control-touch` tall and the `data-key` link's hit area fills its cell; a standalone `.vz-link` gets the same `::after` area as a button; lists of links (Related) get `space-3` vertical padding per item instead of a `space-2` gap.

**B2. Hit areas overlap where a header or form wraps.** Screen 3 at 400: the "Needs attention" segment and "New monitor" overlap by 4 px. Screen 5 at 400: the "Start an investigation" checkbox overlaps "Save monitor" and "Cancel" by 2 px. Image `3-monitors-coarse-400-hitareas.png`. Rule: "Small controls are not stacked in adjacent rows, where their hit areas would overlap."
Change: any row of controls that can wrap, and any stack of form controls, uses a `space-3` row gap with a coarse pointer (32 px drawn + 12 px = 44 px pitch). Make this a system rule, not a per-screen fix.

**B3. The alert's start time is stated three ways.** Screens 3, 4, 2. Images `flows/shots/4-monitor-light-1440.png`, `3-monitors-light-1440.png`. Rule: Feedback, accurate ("Do not present old data as current"; rubric: blocker if inaccurate). Monitor's header says "Firing since 13:02, for 2 h 14 m"; the same screen's chart caption and History say it fired at 13:07 and was pending from 13:02. Monitors lists "Firing … 13:02, 2 h 14 m". The same list shows ingest lag firing for 36 m with an investigation "Running, 40 s", though investigations start when a monitor fires; one of the two numbers is wrong. The dashboard banner says "Burning error budget since 13:02". The chart draws the rise at about 12:52–12:58.
Change: one definition. Header: "Firing since 13:07 (2 h 9 m). Above 500 ms since 13:02." Monitors: rename the column "Firing since" and show "13:07, 2 h 9 m"; for pending rows show "Above threshold 4 m of 10 m". Dashboard banner: "p99 latency above 500 ms since 13:02; the monitor fired at 13:07." Fix the ingest row to "Report ready" or "Running, 26 m". Redraw the chart so the crossing is at 13:02.

**B4. The backtest chart contradicts its sentence and the field beside it.** Screen 5. Image `5-new-monitor-light-1440.png`. Rule: Feedback, accurate; Charts. The chart shows the value above the dashed 1% threshold continuously from Saturday to now, ending near 1.5%. The sentence says it would have fired twice, for 14 and 31 minutes; the help line says the value now is 0.4%. A person choosing a threshold from this picture is misled. The chart also has no unit, and at 7 days in 60 points (2.8 h per point) a 14-minute firing could not be drawn at all, with no rollup stated.
Change: draw the series near 0.4% with two short excursions, mark each would-be firing as a shaded span on the time axis with its duration labelled, put "% · last 7 d · 5 min max per point" in the panel meta, and label the dashed line "1% threshold".

**B5. Chart series fall below, or cannot be read without, colour.** Screens 2, 6, 7. Images `2-dashboard-grey-1440.png`, `6-investigation-grey-1440.png`. Rule: contrast floor 3:1 for marks; "Shape and word carry the state; colour reinforces it" applied to series by the Panel rule "Label up to four series directly". Measured in light: `series-3` on `ground` 2.82:1 (fails), `series-2` 3.20:1, `series-1` 4.42:1. In greyscale the three lines are the same grey and the legend swatches are identical, so "which route is above the objective" (reading-order item 3 on the dashboard) is unanswerable without colour.
Change: darken `series-3` in the light theme to at least 3:1; label each line directly at its right end ("POST /v2/orders 912 ms"); see M6.

**B6. No focus, error, loading, empty or partial state is imaged for any screen.** All screens. Rule: rubric States ("blocker if focus or error is missing"); review.md item 3. REVIEW-INPUT lists this as a known gap; the rubric does not allow it. The states that decide whether these designs work are exactly the missing ones: Monitor after Acknowledge and after Silence; Monitor when its query errors or returns no data; Save monitor with an invalid threshold or a query returning many series; Dashboards with no dashboards and with a search that matches nothing; Investigation while running and when it failed; Keys at the moment a key is shown once; a dashboard panel that is "Not updating".
Change: image at least focus (one per screen) and the states named above before re-review.

## Majors

**M1. On Monitor, the state is the weakest text in the header and the next step is buried.** Screen 4. Image `4-monitor-grey-1440.png`. Rule: Hierarchy; Purpose. In greyscale the eye goes to Acknowledge, the title, then the chart; "Firing since…" is `ui` in `ink-secondary` with an 8 px mark. The investigation, the most useful thing for someone woken up, is a link in the third column of a History row. Nothing says whether anyone has acknowledged or who was paged.
Change: set the status line in `heading`, `ink`. Under it one line: "Not acknowledged. Paged Dana (payments on-call) at 13:07; repeats at 17:07." Above the chart, a `vz-banner` with the info mark: "An agent's report suggests payments-db has been slow since 12:58. Not verified." and the link "Read the report". Move Rule below History; remove "Reads … Cost class: tail" from this page (it answers nothing for on-call; it belongs to Edit rule).

**M2. Silence is unsafe on a phone at night.** Screen 4. Images `4-monitor-coarse-400-hitareas.png`, `4-monitor-dark-400.png`. Rule: Feedback ("an optimistic change is allowed only when it can be undone"); Touch; flows rule on cautionary actions. Acknowledge and Silence are 8 px apart, both act at once, neither has an undo or a drawn result, and the duration is fixed at 1 h. In dark the yellow fill is 13.3:1 against the page while green is 3.7:1, so the cautionary action is the loudest thing on the screen. The flow table promises "resolved"; there is no such action.
Change: order "Acknowledge", then `space-6`, then "Silence…" which opens a `vz-menu` (15 m, 1 h, 4 h, Until resolved). After either, the button is replaced in place by text plus undo: "Acknowledged by you at 15:16. Undo" / "Silenced until 16:16. End silence". Add one line under the buttons: "Silencing stops pages and #payments-alerts messages; the rule keeps evaluating." Delete "resolved" from flow 3 or state "Resolves by itself when below 500 ms for 5 m".

**M3. Investigation's reading order is inverted, and the primary action asks for a verdict before the evidence.** Screen 6. Image `6-investigation-grey-1440.png`. Rule: Hierarchy; Words (buttons are verbs that say what will happen). Intended: first claim, its query, the caution. Delivered: the dark "This was the cause" button, the full-width banner, the "Most likely" heading, then the claim. The banner says to open the query before acting while the blue button above it invites acting. Neither label is a verb and nothing says what pressing does.
Change: remove the banner. Move the two buttons to the end of the left column under a `heading` "Your verdict", labelled "Confirm this cause" (blue) and "Reject it", with a line: "Recorded on the alert's history and shown to the next person. Does not change the monitor." Put the caution where it applies, as the label on each claim (M4).

**M4. Agent claims read as fact.** Screens 6, 4, 3. Image `flows/shots/6-investigation-light-400.png`. Rule: flows rule "Anything an agent wrote says so, and links to the evidence"; Status README (dash means unknown). Authorship appears once, in the subtitle; at 400 px it scrolls away and the bold sentence "The payments database is slow to respond, starting 12:58." stands alone. "Confidence: high" is in `ink-muted`, the weakest text on the page. Claim 2 has links but no query. The three ruled-out items use the unknown mark (a dash) to mean "ruled out", and the mark sits above the text line. History on Monitor says "2 likely causes"; the report has one cause and one scoping statement. The chart's range is "12:00 to 15:00" on a report finished at 13:09: it does not say whether it is the evidence as the agent saw it or live data.
Change: each claim starts with a `label` line "Agent's claim · confidence high · not verified" in `ink-secondary`; the claim sentence drops the bold after verification is absent (weight 600 only on the subject, "payments-db"). Every claim, including 2 and the ruled-out ones, shows its query in a `vz-query` with "Open in Explore". Replace the dash with the word "Ruled out" in `label`. History: "Investigation finished: payments-db suspected". Chart meta: "ms · 12:00 to 13:09, as the agent read it" with a link "See it now".

**M5. Proposed change cannot be reviewed as a diff, is all or nothing, and disagrees with two other screens.** Screen 7. Image `flows/shots/7-proposed-change-light-1440.png`. Rule: Purpose (flow 7: "with the diff seen first"); Feedback. Only the added panel is shown; the changed panel has no before and after; the removed panel is not shown; where the new panel lands is unknown. An unrelated removal is bundled with the incident fix and cannot be declined alone. The warning names "1 runbook" with no link, and Apply stays blue beside it. The query under Checks has no label. Meanwhile Dashboards says checkout-api was "changed 2 h ago, by an agent" although "Nothing has been changed yet"; the dashboard already shows the dashed objective this proposal adds; and the list says 9 panels where the dashboard has 7.
Change: add a `vz-check` per row in "What changes" (all checked; the Remove row unchecked while its warning stands) and label the button "Apply 2 changes". Under the table, one before/after pair per changed panel. The warning becomes "The removed panel is linked from the runbook 'Checkout latency'" with that link. Label the query "Query for the new panel". State what Apply does: "Creates revision 15. You can restore revision 14." Fix the fixtures: Dashboards row reads "12 d ago, by Dana · 1 change proposed"; remove the dashed line from screen 2 or make it the "after".

**M6. Charts miss the system's own requirements.** Screens 2, 4, 6, 7. Images `flows/shots/2-dashboard-light-1440.png`, `4-monitor-light-1440.png`. Rule: Panel README ("Label up to four series directly"); rubric Charts (rollup stated); Words (state completeness). No series is labelled directly. The threshold is explained in a sentence below instead of on the line. Ticks are "1.0k, 667, 333, 0", so the 500 ms line sits on no gridline and mixes "1.0k" with plain numbers. No chart states its step (6 h in 60 points is a 6-minute step: is it max or mean?). The time axis ends at 15:00 while every "ago" on the set implies now is 15:16. Monitor's chart has no mark at 13:02 or 13:07. On Monitor the query is clipped at 1440 px exactly at "> 0.", hiding the threshold, and is in seconds while the chart is in ms.
Change: ticks 0, 250, 500, 750, 1,000; label the dashed line "500 ms objective" at its left end; direct labels at line ends; meta "ms · 09:16 to 15:16 · 6 min max"; vertical markers "Above 13:02" and "Fired 13:07" on Monitor, and the 09:41 deploy on the dashboard; the Monitor panel shows "p99 of checkout-api > 500 ms for 5 m" as text with the query below it, wrapped at operators or scrolled so the comparison is visible.

**M7. The dashboard's numbers do not agree with each other.** Screen 2. Image `flows/shots/2-dashboard-light-1440.png`. Rule: Words (numbers carry units; state completeness); Stat README (context says what the number is measured against). The four figures state no window. Errors reads 2.41%, but the Routes table (last 5 min) weights to 1.67% (requests do sum to 1,284/s). GET /v2/cart/{id} is 488 ms p99 in the table and about 330–400 ms on the chart, and is marked "Slow" though under the 500 ms objective. The banner says "Burning error budget" for a latency threshold, and "61.4% left" gives no rate.
Change: each stat's context line starts with its window ("last 5 min · …"). Error budget context: "30-day window, 99.9% target · at this rate, gone in 3 d 4 h". Banner per B3. Make the fixture numbers agree, and either drop "Slow" or state its rule ("within 5% of objective").

**M8. Dashboards hides that it is partial and is not in urgency order.** Screen 1. Image `flows/shots/1-dashboards-light-1440.png`. Rule: Words ("State how complete a result is"; rubric major); Hierarchy. The subtitle says 24 dashboards and 3 critical; the table has 6 rows and 2 critical, with no count, sort or paging. A warning row sits between two critical rows.
Change: sort critical, warning, no data, healthy; add under the table "Showing 6 of 24, most urgent first. Show all 24" (link); make "3 have a panel in a critical state" agree with the rows. Add a filter "Mine" beside the search, since the stated user is looking for their dashboard.

**M9. Keys does not show the flow it is for.** Screen 8. Image `flows/shots/8-keys-light-1440.png`. Rule: Purpose; method ("Truncate in the middle for identifiers"). Flow 8 ends when "a key exists, was shown once, and its first data has arrived"; creation and the shown-once moment are not drawn, so the only irreversible step is unreviewed. The never-used key (reading-order item 1) is the third row with the faintest mark. Revoke is behind "Manage". Keys are truncated at the end ("viz_k7Qm…"). "5.76 B" reads as bytes; the read key's Samples cell is blank; dates have no year; Settings is not marked current in the navigation; the snippet has no Copy and does not say what goes in `/etc/viz/key`.
Change: draw the New key `vz-dialog` (name, Write or Read, "Create key") and the shown-once state (the key in `vz-query`, "Copy key", and "This is the only time the key is shown"). Sort never-used keys first with the status "Never used, created 14 m ago". Replace "Manage" with a row menu: "Rename", "Revoke key" (red, confirmed by dialog). Show "viz_k7…4f2a". Head "Samples written, 24 h", value "5.76 billion", and "Reads only" for grafana.

**M10. At 400 px and at 200% zoom, Monitors loses the columns it exists for.** Screen 3. Images `flows/shots/3-monitors-light-400.png`, `3-monitors-zoom200.png`. Rule: Hierarchy (reading-order item 3 is "the current value against the threshold"); Narrow. At 400 px only Monitor, State and a clipped Since are visible; Now, Threshold and Investigation need a sideways drag, at night, one-handed. The same happens to p50 and p99 on the dashboard's Routes table and to "Why" on Proposed change. The page does not scroll, so the letter of the rule is met and its purpose is not.
Change: see system change 2. For this screen below 640 px: two lines per row, "checkout p99 latency" / "Firing 2 h 9 m · 912 ms, limit 500 ms · Report ready".

**M11. New monitor omits what the paged person will need, and sends a notification nobody asked for.** Screen 5. Image `flows/shots/5-new-monitor-light-1440.png`. Rule: Purpose (questions nothing answers). There is no field for what the notification says or where its runbook is, no choice for missing data beyond the operator, and no severity (page or message). "A test notification is sent when you save" is not optional. The query is not editable and has no way back to Explore. The threshold is typed as "1%" against a query that returns a ratio. The name duplicates a monitor that already exists on screen 3.
Change: add fields "Message" (placeholder "What is wrong and what to check first") and "Runbook link"; a select "If the query returns nothing" (Keep the last state, Fire, Resolve); under Notify a `vz-segmented` "Page" / "Message only"; replace the help line with a `vz-check` "Send a test notification on save" (unchecked); add the link "Edit in Explore" beside the Query label; help under Threshold: "The query returns a ratio; 1% is 0.01."

## Minors

- All screens: `vz-num` inside prose leaves a double gap before the unit ("Evaluated 20  s ago", "every 4  h while firing", "above 500 ms for 5  m"). Image `3-monitors-zoom200.png`. Rule: Detail. See system change 6.
- Screens 3, 4: numbers in Since, Now, Threshold and History's Value are left-aligned. Rule: Type ("align right"). Either right-align or change the rule for mixed-unit columns (system change 9).
- Screens 1, 8: a `vz-status` with no state ("No data for 3 h", "Never") sits about 2 px lower than the row's other text. Rule: Detail (baselines).
- Screen 6, 2: in the light theme `status-info` is the same value as `blue` (18, 87, 255), next to the blue button. Rule: "Button colours are not used for status."
- Screen 4, light: the yellow button's fill is 1.41:1 against `ground` and it has no border; its edge is not visible to low vision. Rule: 3:1 for control borders.
- Screen 8: Settings is not marked current; "acme-prod" looks like a section link, not a tenant switch.
- Screen 2: `vz-select` holds one option ("environment: prod"); the Select rule is for more than six. Use the label as text until there is a choice.
- Screen 2: "last 5 min" beside "5 m" elsewhere; pick one unit form.
- Screen 3: "Report ready" and "Show them" are link labels without objects: "Read the report", "Show 31 healthy monitors".
- Screen 7: "Edit first" does not say what is edited or where it leads (hand editing is not designed). "Decline" does not say whether the agent is told why.
- Screen 5: "Check every" and "For at least" accept "10m" while every other duration on the set is written "10 m".
- Screen 6: "Could not check" is a section the reader most needs; its text is `ink-secondary`. Set it in `ink`.

## Missing flows and dead ends

Ranked by how soon a real team hits them.

1. **Alert to traces and logs (first page).** Monitor's "Traces slower than 500 ms" and "Error logs", and Investigation's "12 slow traces", lead to screens that do not exist. Flow 3 ends at "understood", which metrics alone rarely achieve. Until trace and log views exist, define these links as Explore queries and say so.
2. **The notification itself and acknowledging from it (first page).** Flow 3 starts "from a notification link" but the page text, the push and the chat message are not designed, and neither is the state after Acknowledge: who has it, whether others are told, escalation if nobody does. A second responder opening Monitor cannot tell if they are alone.
3. **What changed (first incident).** No deploy, config or flag markers on any chart; "Deploy markers" on Investigation goes nowhere defined. This is the first question in most incidents.
4. **Starting from nothing (first hour).** Dashboards and Monitors have no empty state; nothing leads from "first samples arrived" on Keys to a first chart. Flow 8 stops one step before the product is useful.
5. **Who gets notified (first week).** "payments on-call" is a name with no screen: no schedule, routes, escalation or channel setup, and no way from Monitor to see who that is tonight. The Silenced filter exists but silences cannot be listed, edited or ended.
6. **Dead end after the diagnosis (first incident).** Investigation concludes "payments-db is slow" and stops: no owner, no dashboard, no way to notify that team, no link back to Acknowledge, and no link to the proposed change that screen 7 says came from it. Monitor does not show the verdict either.
7. **Explore (flow 1) is not in the set.** Six screens hand off to it ("Open in Explore", "From the query you ran in Explore") without showing what arrives: the query, the range, the incident window. Flow 5's other entry, "or a panel", has no control on any panel.
8. **Compare and share (first week).** No "compare with last week" on Dashboard or Monitor (only a sentence on one stat), and no share or copy-link, though flow 1 ends when "the link is shareable".
9. **Cost and cardinality (first invoice).** The platform owner gets a per-monitor estimate and nothing else: no usage, top metrics by series, limits or retention. Keys shows samples per key but not series.
10. **Agent work in progress and in bulk.** No list of investigations or proposals, no running or failed investigation, no place to set what an agent may read, and no notification for flow 7.
11. **After it is over.** No resolved state for a monitor, no incident timeline to export, no way to turn a confirmed cause into a note on the alert.
12. **Dashboard to its monitors.** The banner links to one monitor; there is no way to see all monitors on this service, and Dashboards' State column does not link to what is wrong.

Order of importance in the flow table: "Respond to an alert" should be flow 1 and should be designed phone first; it is currently third and designed desktop first.

## System changes these screens need

Screens misusing the system: the fixture inconsistencies (B3, B4, M5, M7), the missing direct labels (M6), the dash mark used for "ruled out" (M4), end truncation of keys (M9), the unimaged states (B6). Everything below is the system falling short.

1. **Link and table touch targets.** `vz-link` has no coarse-pointer hit area, and `row` (32 px) makes one impossible in a table. Define: touch rows at `control-touch`, the key link filling its cell. (B1)
2. **A narrow form for tables.** "Scrolls inside its container with the first column fixed" keeps the page still but hides the answer. Add column priority (`data-priority`) so low-priority columns fold into a second line under the key below 640 px. (M10)
3. **Wrapped control rows.** A rule and a utility for the row gap between wrapped controls with a coarse pointer (`space-3`). (B2)
4. **Chart component.** There is no chart, only a panel around one. It needs: direct end labels, a labelled threshold, event markers (fired, deploy, silence), shaded spans, "nice" ticks that include the threshold, a stated step and aggregate, and a second channel besides hue (end labels, or dash patterns from the fifth series). `series-3` needs a darker light-theme value (2.82:1 now). (B5, M6)
5. **Action colours.** With green and yellow side by side and no blue, the rule "yellow cautions" gives the cautionary action the highest contrast in dark (13.3:1) and an invisible edge in light (1.41:1). Give toned buttons a `rule-control` border, and let a cautionary action be a default button whose menu or dialog carries the yellow. `status-info` must differ from `blue` in light. (M2)
6. **Numbers in prose.** `vz-num` in a sentence breaks the spacing before the unit. Add an inline form that sets the digits in mono and the space and unit in the sans, or a `vz-age` / `vz-duration` element used everywhere a time is stated.
7. **Missing components**, each built ad hoc in `flows/build.mjs`: page header (title, state line, actions; `.head`, `.sub`); key-value list (`.kv`); two-column page (`.two`); timeline (History is a table without comparable rows); agent-authored block with provenance, confidence and evidence (`.claim`); before/after diff (`.diff`); secret shown once with Copy; link list. The breakpoint in that file is a literal 800 px with a lint exemption; it should be a container query on the system's 640.
8. **Status vocabulary.** Monitors need acknowledged and silenced; reports need "ruled out". The five shapes cover none; decide whether these are states (new shapes) or words without a mark.
9. **Rules to amend.** "Numbers align right" needs an exception for columns of mixed units. The Banner allows "one small button"; navigation must be a link, so allow one link. The Stat needs a required window or age. The Panel age rule should extend to the page ("every screen states how fresh its data is" is a flows rule, not a system rule).
10. **Review input.** Require one fixture clock and one set of numbers per incident across screens, stated in REVIEW-INPUT, so consistency can be checked rather than discovered.

## What works and should be kept

- "What it answers" as a column and as the dashboard subtitle; panel descriptions that say what to conclude.
- Status words that say what is wrong ("Burning budget", "Lagging", "No data for 3 h") with shapes that survive greyscale.
- Monitors defaulting to "Needs attention", with healthy monitors collapsed to one line and the watchdog's last test stated.
- "If this rule had existed" and "What it costs to run" beside the form, once the chart is true.
- On Investigation: "Checked and ruled out", "Could not check", and "Could read / Could change: nothing".
- "Nothing has been changed yet" and the Checks list, including a warning, on Proposed change.
- A stated age on every screen, and "checked 3 s ago" on the waiting panel in Keys.
- No blue button on the two reading screens; one elsewhere.
- No sideways page scroll at 400 px, 320 px or 200% zoom; queries scroll in place.
