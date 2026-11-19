# Flow screens: revisions

Newest first. Each revision says what changed, why, how it was checked, and what it did not do. Only
`design-system/flows/` was edited in each; nothing here claims a review verdict.

## v5: the screens moved onto design system v5

Input: design system v5 (`reviews/system-v5/response.md`, not yet reviewed), which answered the
v4 review (`reviews/system-v4/review.md`) and the 16 system gaps listed under revision 2 below. The
screens of revision 2 depended on v4 behaviour v5 changed (a chart's height on touch, series told
apart by hue alone, links inside sentences) and drew their own waterfall and log lines. This
revision moves every screen onto v5's components and tokens, removes every work-around v5 made
unnecessary, and keeps the content, the clock (Wed 18 Nov 2026, 15:16) and the incident. The
system itself (`src/`, `project/`, `tools/`, `dist/`), `reviews/` and `app/` were not edited.

### How it was done

1. Read v5's rules, rubric, method, tokens, response and the Chart, Waterfall, Log, Section,
   Button, Menu, Timeline, Table, Field, Claim and Notice components; listed every place in the
   screens that used a v4 class, a `flow-*` work-around or an inline style.
2. Rewrote the screens against v5 (below), one at a time, rendering each at 1440 and at 400 px with
   a coarse pointer after each change and fixing what the images and the measure showed (round 1:
   eight findings, listed under "Found while imaging").
3. Re-imaged every screen and state with `tools/shots.mjs` (`node build.mjs --shots`): 1440 and 400
   in both themes, the same data and states as the v4 images. The v4 "before" images were rendered
   in the same session by the same `shots.mjs`, from the v4 screens on v4's own CSS and chart (a
   copy of v4's `dist/` as reviewed, checksum-identical in four independent copies, kept in the
   session's scratch area; a v4 image re-rendered this way matched the stored v4 image to within
   palette encoding: 174 of 1.3 million pixels differ by more than 30 of 765). Pairs are in
   `compare-v5/`.
4. Measured touch targets, overflow and layout shift (below), and ran `tools/check.mjs` on the flows.

### What changed, by screen group

| Screens | v4 | v5 |
|---|---|---|
| All | `build.mjs` carried 12 lines of work-around CSS (`flow-pop`, `flow-menu-note`, `flow-indent`, `flow-bar`, `flow-scale`, `flow-wrap`, `flow-said`, the skip link's position); a nav spacer and the tenant's colour as inline styles; page state lines as a mark in an inline-styled span with a non-breaking space | `build.mjs` adds only state switching (`body` margin, `[hidden]`). The nav's right group starts with `vz-nav-end`. State lines are one run of text, the mark first, times as `<time class="vz-qty">` scaled to the heading. Help lines are one run (no wrapper spans). Paragraphs are `vz-text` / `vz-secondary` / `vz-dialog-text`. Regions that hold no chart or table (History, Rule, Related, About this report, Checks, the page and message on 11, Sent, If nobody acknowledges, What it costs to run) are `vz-section`s, not panels, as Section and Panel now say. The middle dot appears only in panel meta and legend names |
| 2, 4, 5, 6, 7, 9, 10 (charts) | Charts reserved no height before data (on a phone the page shifted when data landed); hue told series apart where direct labels were missing | Every chart sets `--legend-rows` and `--legend-notes` from its last result (3 and 1 for routes and dependencies, 2 and 0 for p99/p50, 1 and 0 for one series, 10 and 2 for 36 pods), so it reserves its drawn height on every pointer; measured below. v5's palette (lightness stagger, slots 5 to 8 dashed), legend emphasis and the nearest-series readout come with the chart. The agent's marker is a v5 agent marker (`agent: true`: "Agent:" and the agent's rule, G15). The log rate's unit is written in full, "lines/min" (G8). The products error figure reads "< 0.1" in the Routes table, as v5's legend now prints it, so table and legend agree |
| 4 Monitor, 11 Notifications | Acknowledge and Silence replaced by loose text and a button; Silence menu anchored by a work-around; notice outside the header; agent banner with its own mark; links inside timeline sentences already moved, but escalation and sent lines used the no-state dash | Acknowledge and Silence are replaced in place by `vz-done` ("Acknowledged by you at 15:16" with Undo; "Silenced until 16:16 by you" with End silence). The Silence menu is `vz-menu-anchor` with `vz-menu-note` and the yellow confirm inside it; with a coarse pointer below 640 px it is a sheet at the foot of the screen. The failed acknowledgement is a Notice in a `vz-notice-group` under the controls that started it. The agent banner has no mark of its own; the agent's history line has the agent mark and "Read the report" standing under it. Escalations and notifications sent take the info bar (G16). On 11, the in-sentence link to the monitor is replaced by a standalone "Open the monitor to acknowledge it" in the head |
| 9 Traces | A folding table with hand-made bars (`flow-bar`, `flow-indent`, `flow-scale`); the chosen trace in the list had no mark | **Waterfall**: a treegrid with Took, Own and Starts at, bars as `--at`/`--len` fractions, the two payments-db spans in `ink` with strong names because their own time is a tenth of the trace or more (the root's own time is 26 ms), a collapse toggle on the root, one tab stop with arrow keys, and the chosen span's detail under the table with "Logs from this span" (the flow's main path, standalone). The trace is the screen's own 8 spans; own times are computed in `fixture.js` (`--facts`). The chosen trace in Slowest traces is drawn (`aria-current`: `rule` fill, `ink` edge; G13). Folded cells are `vz-num` with labels again (G7) |
| 10 Logs | A folding table with `flow-wrap`; "Show 214 newer lines" as a button row above the table | **Log**: time with milliseconds as the key, the message wrapping in mono and cut after four lines if longer, the level stated once in the caption because the search names one level ("all at error"), the strip `vz-log-tail` holding the count, "Paused while you read" and "Show 214 newer lines"; the meta says "paused at 15:16:02" |
| 6 Investigation, 7 Proposed change | Provenance parts separated by " · "; sub-lines held links to the monitor and the investigation; `flow-said` paragraphs; Apply replaced by Restore and a link; notices outside their controls | Provenance parts are spaced, no separator. No link inside a sentence on 6; 7's link to the investigation is a standalone "Read the investigation" in the head. Apply is replaced in place by `vz-done` ("Applied as revision 15", Restore revision 14). Notices sit under the control that started the action. Diff rows say "Changes and Goroutines", not "Changes · Goroutines" |
| 1 Dashboards, 3 Monitors, 8 Keys, 12 Who is notified | Search and threshold fields sized by inline styles; Keys' waiting panel narrowed by an inline style; row actions "Rename or revoke…"; first-run "New key" a button; at 400 px a status in a kept column was cut ("Above 500", "Orders faili", "Never usec"), in v4 as well | No inline style: the search has a visible label ("Search by name, service or owner"; Field: the label is always visible) and sits with the Whose choice in the list's own controls, both fields sized by the input's `size` attribute. Monitors folds below 1200 px (`data-fold="wide"`) with thresholds as `vz-phrase` pairs. Keys' row menu is "Actions…" in `td.vz-row-actions`, a menu anchored at its end; the waiting block is a FirstRun block (`vz-start`, measure wide); dialogs use `vz-dialog-text`. First-run "New key" is a link drawn as a button (G12). The status columns that were cut fold into the first place under the key; Keys' and Silences' actions are the kept column, so they sit on the key line |
| 5 New monitor | Message a one-line input; inline field widths; "Who is notified" inside a help sentence | Message is a `textarea.vz-input` (G10); fields sized by `size`; the help line is plain text and "Who is notified" is a standalone link under it; the form is one `vz-stack` in its own column (a `vz-split` column is a column of sections and would space fields `space-8` apart) |

### Found while imaging, and fixed

| Seen | Cause | Fix |
|---|---|---|
| "They add up to1,284 req/sand1.69%errors" (Routes caption) | v5's `vz-table-caption` is a flex row, so the spaces around a `vz-qty` collapse | The caption's words in one span (system gap G17) |
| Fields in New monitor 32 px apart, help lines 13 px further | The form was itself a `vz-split` column (gap `space-8`); `p.vz-help` keeps the browser's paragraph margins | Form wrapped in its own column; `span.vz-help`, as the Field preview uses (G18) |
| "Above 500", "Orders faili", "Never usec" at 400 px (also in v4's images) | A status does not wrap, and a kept column is `keep` (26%) wide | State and Last used fold first under the key (G19) |
| "Actions…" cut at the right edge at 400 px | `td.vz-row-actions { width: 0 }` in the folded form | The actions cell is the kept column (G20) |
| A folded line indented by 24 px | The gutter after a right-aligned column applies in the folded form too | Right-aligned columns placed last, or the state column before the figures (G21) |
| "End silence" with a 43.8 px touch area | A small button on a folded row's last line: the table wrap clips its 44 px area | On the key line, as the kept column |
| Keys at 400 px measured 0 hit areas (v4's Keys measures 0 with v5's tool too) | `shots.mjs` takes the first `.vz-scrim` in the page for the open dialog, even a hidden one, and measures only inside it | A dialog's scrim class is set only while it is shown (`data-scrim`; G24) |
| The row menu at 400 px drawn at the foot of a 1,900 px page | A menu is a sheet across the bottom of the screen with a coarse pointer; a page-tall capture puts the screen's bottom at the page's | Menu states at 400 px imaged at a phone's height, 800 px |

MEASUREMENTS-V5

## Revision 2, on v4: what changed and why

Input: `reviews/flows-v1/review.md` (reject: 6 blockers, 11 majors, 12 ranked missing flows),
answered on design system v4 as it stood on 18 Nov 2026 (`reviews/system-v4/CHANGES.md`, its
"Migration notes for the flow screens"). Only `design-system/flows/` was edited. The verdict is
for an independent reviewer; nothing here claims one.

Images are in `shots/` (100, `<screen>-<state>-<theme>.png`, palette-encoded with every token
colour exact), before/after pairs of the eight v1 screens in `compare/` (24), measurements in
`measurements.txt`. The one incident and its figures are in `REVIEW-INPUT.md`.

### How it was done

1. Fixed one clock (Wed 18 Nov 2026, 15:16, the reference chart's own "now") and one incident,
   wrote the chart data as a seeded fixture with every stated figure pinned (`fixture.js`), and
   checked the sums (`node build.mjs --facts`).
2. Rewrote every screen from system classes only, following the migration notes: `vz-page`,
   `vz-page-head` with `vz-page-state`, `vz-controls`, `vz-stack`, `vz-split`, `vz-kv`,
   `vz-timeline`, `vz-claim`, `vz-changes`/`vz-diff`, `vz-secret` in `vz-scrim`, `vz-notice`,
   `vz-start`/`vz-steps`, `vz-empty`, `vz-table[data-fold]` with `data-priority` and `data-label`,
   `vz-table-caption`, `vz-qty`, and every chart drawn by `dist/viz-chart.js`. v1's hand-made
   `.head`, `.sub`, `.row`, `.stack`, `.two`, `.kv`, `.claim`, `.diff`, `h2.sec`, the SVG `line()`
   function and the literal 800 px breakpoint are gone. What remains in `build.mjs`'s CSS is
   state switching and the fix-ups named under "System gaps found".
3. Added four screens (traces, logs, the notification, who is notified) and the states.
4. Imaged with `tools/shots.mjs scenario` (`scenarios/*.json`, generated by `build.mjs`), looked at
   every screen and state, fixed, and re-imaged: three full rounds, then a partial fourth.
   What the rounds found and fixed: palette encoding that shifted white to 252 (replaced by exact
   nearest-colour mapping); a Silence menu that covered 2 px of its opener's hit area; small row
   buttons whose 44 px areas were clipped by the next folded row (3 places); long state lines
   whose mark was left alone on a line at 400 px; help lines splitting "0.40%" from its full stop;
   folded mono cells running their label into the value ("Started15:14:52"); a chart unit
   ("lines/min") hanging off the left edge; links drawn as buttons keeping an underline; an
   agent's marker word on a dashboard panel without "Agent:"; a claim saying "drawn on the right"
   at 400 px, where the chart is below; a query clipped before its distinguishing label.

**Measured** (coarse pointer, 400 px, every screen and every 400 px state; plus 1440 and 200%
zoom): sideways overflow 0 px in all 76 measured captures; 610 hit areas, **0 under 44 px or
overlapped**; smallest text 11 px (`micro`, chart axes); no sans text in tabular figures.
`node tools/check.mjs flows/screens`: contrast 240/240 pairings pass, **literal values 0** in 12
files (0 in 14 with `build.mjs` and `fixture.js`).

### Blockers

| Finding | What changed | Images |
|---|---|---|
| **B1** Links 18–20 px with a coarse pointer | System v4 touch rules applied by structure: every standalone link is in `vz-links`, a table key or its own `vz-controls` row; links inside sentences are only secondary paths (and the two that were in timeline sentences were moved out, see v4 review M3 below). Measured: 610 areas, none under 44 px | `3-monitors-400-hit-areas-light`, `4-monitor-400-hit-areas-light`, every `*-400-light` |
| **B2** Hit areas overlap where a header or form wraps | Every row of controls is `vz-controls` and every form `vz-stack`; the Silence menu sits `space-2` below its opener so it does not cover the opener's area. Measured: no overlap anywhere | `3-monitors-400-hit-areas-light`, `5-new-monitor-400-light`, `4-monitor-silence-menu-400-light` |
| **B3** The alert's start stated three ways | One definition everywhere: "Firing since 13:07 (2 h 9 min)", "above 500 ms since 13:02". The chart crosses 500 ms between the 12:58 sample (384 ms) and the 13:04 sample (541 ms), with markers "Above 13:02" and a span "Firing since 13:07". Monitors' state cell is "Firing since 13:07, 2 h 9 min"; ingest lag is "Acknowledged by Sam at 14:44, firing since 14:40" with its report ready; the dashboard banner and stat say "since 13:02" and "fired at 13:07" | `4-monitor-1440-light`, `3-monitors-1440-light`, `2-dashboard-1440-light` |
| **B4** Backtest chart contradicts its sentence | The system's own backtest data (cart, near 0.40%, two excursions), unit %, "1% threshold" on the line, meta "11 Nov 15:16 to 18 Nov 15:16 · 5 min max", `data-size="sm"`. Spans are when the rule *as set* would have fired: 10 min after each crossing until the fall, so 5 min and 20 min; the sentence says so and gives both the firing and the time above 1% (15 and 30 min). The review's "14 and 31 min" were the excursions, not firings under "for at least 10 min" | `5-new-monitor-1440-light`, `5-new-monitor-many-1440-light` |
| **B5** Series below 3:1 or unreadable without colour | v4's re-stepped palette; direct labels at each line's end on every chart 640 px or wider; one route keeps one colour on both dashboard charts (ranked the same). In greyscale the lines are told apart by their labels and positions | `2-dashboard-grey-light`, `4-monitor-grey-light`, `6-investigation-grey-light` |
| **B6** No focus, error, loading, empty or partial state | Every screen has a focus image and an error image; plus: Monitor acknowledged, silenced, Silence menu, acknowledge failed, query failing, no data; New monitor invalid threshold and 36 series; Dashboards with no dashboards (no data) and no match; Investigation running and failed; Keys new key, shown once, saved, copy failed, revoke, first data; Dashboard panel not updating and waiting on a longer range; an empty panel | `*-focus-light`, `*-error-*`, and the state list in `README.md` |

### Majors

| Finding | What changed | Images |
|---|---|---|
| **M1** Monitor's state weakest; next step buried | State line in `heading`, `ink`, with the critical mark; under it who was paged and when the next page is ("Nobody has acknowledged: Dana was paged at 13:07 and Kim at 13:37 (payments on-call); next page at 17:07"); the agent's banner "Agent: payments-db has been slow since 12:58. Not verified." with "Read the report"; History beside the chart, Rule after it; the cost class removed | `4-monitor-1440-light`, `4-monitor-grey-light` |
| **M2** Silence unsafe on a phone at night | Acknowledge (green) and "Silence…" (a default button) are the only actions; Silence opens a menu of durations with the end time (15 min, 1 h, 4 h, until it resolves), a sentence saying what it stops, and the yellow "Silence until 16:16" confirm inside it, so no yellow is on the page at rest. After either, the button is replaced in place: "Acknowledged by you at 15:16. Undo", "Silenced until 16:16 by you. End silence"; the state line and history change; a failure is a notice under the actions with the old state kept. "Resolved" is now a rule: "every route is below 500 ms for 5 min" | `4-monitor-400-dark`, `4-monitor-silence-menu-400-light`, `4-monitor-ack-400-light`, `4-monitor-ack-400-dark`, `4-monitor-silenced-400-light`, `4-monitor-notice-400-light` |
| **M3** Investigation asks for a verdict before the evidence | The banner and the header's verdict buttons are gone. Each claim reads provenance, claim, evidence query, then "Confirm claim" / "Reject claim"; one line above the claims says what a verdict does ("recorded on the alert's history and shown to the next person; it does not change the monitor or tell the agent anything"). No blue button. The only header action is "Investigate again…" (default) | `6-investigation-1440-light`, `6-investigation-grey-light`, `6-investigation-confirmed-400-light` |
| **M4** Agent claims read as fact | Every claim, including the three ruled out, is a `vz-claim`: "Agent's claim · confidence high · Not verified", only the subject strong, its query and "Open the query in Explore"; ruled out uses the slash mark and the words "Ruled out by the agent"; "Could not check" is marked "Agent:" and set in `ink`; History says "investigation finished; payments-db suspected" (one suspect, not "2 likely causes"); the chart is "12:00 to 13:09 · as the agent read it at 13:09" with "See 09:16 to 15:16 now", and its marker word starts "Agent:" | `6-investigation-400-light`, `6-investigation-1440-light` |
| **M5** Proposed change not a diff, all or nothing, inconsistent | A `vz-changes` list under the agent's provenance line: each change has its own box, "Why:", and Before/After (the new panel drawn with today's data; the description as a struck and inserted text diff; the removal with the runbook warning and the box unticked). "Apply 2 changes" counts the selection; "Applying creates revision 15; you can restore revision 14"; "Declining tells the agent". The query is labelled. Fixtures: Dashboards says "6 Nov, by Dana · 1 proposal waiting"; the dashboard draws 9 panels including Goroutines; the objective line is already on the dashboard, so the change is now to the description, not the line. Applied and failed states drawn | `7-proposed-change-1440-light`, `7-proposed-change-applied-1440-light`, `7-proposed-change-failed-400-light` |
| **M6** Charts miss the system's requirements | All by `viz-chart.js`: ticks 0, 250, 500, 750, 1,000 with one on the threshold; "500 ms objective" (dashboard) and "500 ms threshold" (monitor) on the line; direct labels; unit once at the top of the axis; meta "09:16 to 15:16 · 6 min max · updated 12 s ago"; the axis ends at 15:16; markers Deploy 09:41 and Above 13:02; the firing span. The Monitor shows the rule as words and the query broken so "> 0.5" is on its own line, and says the query is in seconds | `2-dashboard-1440-light`, `4-monitor-1440-light` |
| **M7** Dashboard numbers disagree | Each stat starts with its window; errors are 1.69%, the requests-weighted sum of the route rows; GET /v2/cart/{id} is 315 ms in the table and the chart and is Healthy; the banner is about latency; the budget says its rate ("At the last 5 min's rate, gone in 1 d 2 h"). The routes caption states the sums | `2-dashboard-1440-light` |
| **M8** Dashboards hides that it is partial | Sorted critical, warning, no data, healthy; caption "6 of 24, most urgent first…"; "Show all 24 dashboards"; three critical rows match the sub-line; All/Mine filter beside the search | `1-dashboards-1440-light` |
| **M9** Keys does not show its flow | New key dialog (name, Write data / Read data, Create key); the key shown once in `vz-secret` (masked, Reveal, Copy key, warning, "I have saved the key" gating Done, Discard); never-used key first with a warn mark; row action "Rename or revoke…" opening a menu, revoke confirmed in a red dialog; keys cut in the middle; "Samples written, 24 h" with "5.76 billion" and "reads only"; Settings current; the snippet with Copy and where the key goes; waiting and first-data-arrived states | `8-keys-new-400-light`, `8-keys-secret-1440-light`, `8-keys-saved-400-light`, `8-keys-error-400-light`, `8-keys-revoke-400-light`, `8-keys-menu-1440-light`, `8-keys-arrived-1440-light` |
| **M10** Monitors loses its columns at 400 px and 200% zoom | Folding table keeping Now and Threshold; the same on Dashboards (State), the dashboard's Routes (p99, Errors), Keys (Last used), Traces, Logs and Who is notified | `3-monitors-400-light`, `3-monitors-zoom-200-light`, `2-dashboard-400-light` |
| **M11** New monitor omits what the paged person needs | Message and Runbook link fields; "If the query returns nothing" (Keep the last state, Fire, Resolve); route select with who is on call, and "Page and message" / "Message only"; "Send a test page… when saved", unticked; "Edit the query in Explore"; "1% is 0.01"; durations "10 min"; the name is unique (screen 3's pending monitor is now "catalog error rate") | `5-new-monitor-1440-light`, `5-new-monitor-error-1440-light` |

**Minors**: numbers in prose are `vz-qty`; mixed-unit Now and Threshold columns are left-aligned;
"Read the report", "Show 30 healthy monitors"; "Edit first" removed and "Decline the proposal" says
what it does; "Could not check" in `ink`; `status-info` is v4's cyan; the yellow button has its
edge (and only appears inside the menu); Settings is current on Keys; the tenant is text, not a
link; the one-option select is now text in the sub-line; minutes are "min" everywhere. Not
re-checked: the 2 px baseline of a status with no state in a table row.

### Missing flows from the review's ranked list

| # | Missing flow | Now |
|---|---|---|
| 1 | Alert to traces and logs | **New screens** `9-traces` (search, duration chart with the trace marked, the slowest traces, one trace as a waterfall: payments-db 702 + 255 ms of 1,204) and `10-logs` (error-line rate with deploy marker and firing span, log lines newest first, live tail held with a count). Linked from Monitor, Investigation and each other |
| 2 | The notification and acknowledging from it | **New screen** `11-notification`: the page's title, text, buttons and text-message fallback; the channel message as posted and as edited after acknowledgement; what was sent to whom and when; what happens if nobody acknowledges. The acknowledged state it links to is `4-monitor-ack-*` and `11-notification-ack-1440-light`; a second responder sees "Acknowledged by Dana at 15:16" and that Kim and the channel were told |
| 3 | What changed | Deploy markers on the dashboard, monitor, proposal and log charts; a Changes panel on the dashboard (deploy, the agent's proposal, "no configuration or flag changes"); the agent's deploy claim carries its query |
| 4 | Starting from nothing | First run on Dashboards for a tenant with no data (key, collector, waiting line) and on Monitors (one step); Keys ends at "first samples arrived… See them in Explore" |
| 5 | Who gets notified | **New screen** `12-routes`: on call now with secondary and next, routes with escalation and repeats, silences with End silence, paging health from the watchdog. Linked from Monitor's rule, Monitors, New monitor, the notification screen |
| 6 | Dead end after the diagnosis | Investigation ends with "What next": back to the alert, the slow traces, the proposal made from the report, who is on call for payments-db's owner |
| 7–12 | Explore, compare and share, cost, agent work lists, after it is over, dashboard to its monitors | Not designed (below) |

"Respond to an alert" is now flow 1 in `README.md`, and Monitor is designed phone first: its
400 px images were the ones judged first in each round.

### System gaps found

Each is worked around inside `flows/` with the nearest existing component; nothing in the system
was edited. Classes named `flow-*` are the work-arounds.

| # | Gap | Effect | Work-around |
|---|---|---|---|
| G1 | `.vz-button { position: relative }` comes after `.vz-skip { position: absolute }` and wins, so the hidden skip link keeps a control's height (32 px) above the nav. Visible in v4's own compositions | Every page with the required skip link starts 32 px low | `a.vz-skip.vz-button { position: absolute }` |
| G2 | `vz-page-state` is a wrapping flex row: a state longer than one line drops below its mark | At 400 px "Acknowledged by you, firing since 13:07 (2 h 9 min)" left the mark alone | Mark and words in one inline span |
| G3 | Menu has no anatomy for an explanation or a confirming button, though Controls says a cautionary choice is confirmed by a yellow button inside its menu; nor any anchoring to its opener | The Silence menu needed both | `flow-pop` (anchor), `flow-menu-note`, a `vz-controls` inside `vz-menu` |
| G4 | `vz-help` is a flex row, so inline children (a `vz-qty`, a link) become separate items with gaps | "0.40% ." | Help text wrapped in one span |
| G5 | No trace waterfall | Screen 9 | A folding `vz-table`, bars by start and length as shares of the trace (`flow-bar`, `flow-indent`, `flow-scale`), `ink-muted`, and `ink` for the spans the sentence names. Needs a rule for bar colour, the critical path, nesting and collapse, and a span's own target |
| G6 | No log line | Screen 10 | A folding `vz-table`, time as the key, the message in mono and wrapping (`flow-wrap` overrides the table's nowrap). Needs levels, wrap versus scroll, matched-text highlight, a running live tail |
| G7 | A folded `vz-num` cell's negative word spacing swallows the space after its `data-label` | "Started15:14:52" | Value in a `vz-qty` inside a plain cell |
| G8 | The value-axis unit is right-aligned in the `axis` gutter with no limit; longer than about 5 characters it hangs off the left | "lines/min" left the page edge | Unit "/min", the title says "error lines per minute" |
| G9 | The chart's number format takes its decimals from the step's power of ten, so a 2.5 step prints 2.5 and 7.5 as "3" and "8" (0.25 as "0.3"). Found by reading `viz-chart.js`, not imaged | Ticks would lie | No flows chart lands on such a step |
| G10 | No multi-line text field | New monitor's Message | A one-line `vz-input` |
| G11 | No component for an outbound message (push, text, chat) | Screen 11 | `vz-kv` for the page, `vz-diff` for the message before and after |
| G12 | A link styled as `vz-button` keeps the link underline | First-run "New key" | Real buttons |
| G13 | A selected row in a plain `vz-table` (the trace being shown) has no visual mark | The list does not show which trace is open | `aria-selected` and `aria-current` only; the panel title names the trace |
| G14 | No body paragraph style inside a page or column (only inside `vz-start`, `vz-empty`, `vz-banner`) | Margins | `flow-said` (margin 0, `measure`) |
| G15 | Chart marker words cannot carry the agent's left rule | The agent's "slow since 12:58" on a chart | The word starts "Agent:" |
| G16 | No mark for "a notification was sent" or "escalated" in the Timeline vocabulary | Escalation rows | The no-state dash |

### Depending on v4 behaviour its review rejected

The v4 review (`reviews/system-v4/review.md`, reject) arrived while this revision was being
finished; the system is being revised to v5. Re-image these on v5:

- **B1** (a drawn series promoted into a reserved slot when a filter clears; "highest" in the
  readout over drawn series): no flows screen uses a filter or chooses legend rows, and no image
  shows a crosshair, so no image depends on it; the running views of screens 2, 4, 5, 6, 7, 9 and
  10 would show the readout on interaction.
- **B2** (chart height not reserved on touch phones, layout shift 0.30): the images are static and
  show no shift, but the running views of 2, 4, 5, 6, 7, 9, 10 at 400 px with a coarse pointer
  would shift. Re-measure there.
- **M1** (series told apart by hue alone where direct labels are missing): at 400 px every
  multi-series chart (2, 4, 6, 7, 9) and the small charts at every width (6, 7, `5-new-monitor-many`)
  rely on the legend and hue. Screen 6's claim is about the one line that rises, so position also
  tells it; the others do not.
- **M3** (a link inside a Timeline sentence has a 19 px target): removed from the timelines of
  screens 2 and 4; the links are now standalone ("Review the agent's proposal" under the Changes
  panel, "The agent's report, not verified" in Related). Links inside sentences remain only in
  page sub-lines of 6, 7 and 11 (back to the monitor or the investigation); 6 and 11 also have the
  same link standalone, 7 does not.

### Still not designed

- **Explore**, and what arrives there from "Open the query in Explore", "Edit the query in
  Explore" and "Edit the search in Explore"; the "Make a monitor" entry from a panel.
- Dashboard editing by hand, its Text view, and editing a proposal before applying it.
- Compare with last week; share and copy link.
- Cost and cardinality: usage, top series, limits, retention; tenant settings; sign-in.
- Lists of investigations and proposals, what an agent may read, notifying someone of a proposal.
- A resolved monitor, the incident's timeline and export, a confirmed cause as a note.
- From a dashboard to all monitors on its service.
- Editing routes and rotas (the "New route" form), and a silence made outside a monitor.
- Traces beyond one route's search: span attributes, service map, trace comparison. Logs: context
  around a line, a running live tail.
- The page and the channel message are specified as content (`vz-kv`, `vz-diff`); their look is
  drawn by the phone and the chat product.
- Not measured or checked: speed budgets (no `speed.mjs` run on these static screens), a screen
  reader by ear, real touch hardware, Safari and Firefox, reduced motion, 200% zoom beyond
  Monitors and Monitor, dark at 400 px beyond Monitor.
