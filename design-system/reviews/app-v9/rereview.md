# Design re-review: the viz web app (Explore, Help, Settings, the palette), dashboards, monitors, and the waiting line's last frame

Reviewed 2026-11-28, about 12:50 to 14:15 UTC, by an independent reviewer: an agent session that
did not write the app, the design system, `response.md` or any of the PR files, and was not given
the author's reasoning. Findings were formed from the rubric, the images and the running app;
`response.md` was read only after the Explore findings were written (section "The author's claims
against what I found").

- **What was reviewed.** `app/` at commit `70d3d71`, in a frozen worktree, built there
  (`npm run build`), served by `vite preview` over the development mock, and over a second mock
  started with keys for each scope case (`--require-token`, `--readless-token`,
  `--dashboards-token`, `--monitors-token`, `--oncall-token`).
- **Four parts.** (1) Explore, Help, Settings and the command palette: a re-review after the
  reject in `review.md`. B1 (speed with many series) is ruled on separately in
  `../chart-speed/`; its timings are not judged here. (2) Dashboards, read-only: first review.
  (3) Monitors: first review. (4) The waiting line leaving in the frame that shows the result
  (`../chart-speed/waiting-line/`).
- **Ground truth.** `project/review.md` (rubric), `project/README.md` (rules, "Responsiveness and
  feedback"), `project/method.md`, `tokens.json`, `components/Chart/README.md`,
  `components/Timeline/README.md`, `components/Stat/README.md`, `components/Status/README.md`;
  AGENTS.md "Design changes".
- **How.** Playwright (`chromium.launch()`, headless shell), one browser job at a time under the
  shared machine lock, Cloudflare credentials removed. 1500 px (fine pointer) and 400 px (touch
  emulation, coarse pointer), both themes; 320 px; 200% zoom as 750 CSS px at device scale 2.
  Every reload was read with a fine pointer at both widths and, for the phone layout, with the
  pointer made coarse in Blink (`--blink-settings`, `isMobile`, no `hasTouch`), as
  `tools/audit.mjs` does. Tap areas were read by asking the page which element owns each point
  above and below a control's centre with the control scrolled to the middle of the window.
  Images I cite are mine, under `rereview-images/`, unless an author's file is named.

## Verdicts

| Part | Verdict | Why, in one line |
|---|---|---|
| 1. Explore, Help, Settings, palette | **Reject** (on one speed row; everything a person sees is approve-level) | Every earlier blocker and major I could judge is fixed. One budget row outside B1 is over by the author's own measurement: "Show 50 more" 102 ms desktop, 105 ms phone against 100 (Speed: blocker, no tolerance). B1 stays with its own ruling |
| 2. Dashboards | **Reject** | A dashboard an agent wrote is shown with its titles, prose and threshold status unmarked (Agent content: blocker); the author's figures put the slowest panel's paint at 144 to 197 ms and the all-panels-waiting state at 127 to 165 ms against 100 (Speed: blocker); two majors |
| 3. Monitors | **Reject** | The author's figures put opening a monitor at 117 / 146 ms and its chart's paint at 143 / 122 ms against 100 (Speed: blocker); two majors. Without the speed rows this would be approve with changes |
| 4. The waiting line's one-frame change | **Approve** | The line goes in the frame that shows the result once its 300 ms minimum is met, and stays for the minimum when it is not. That is what the rules ask; nothing true is lost |

The speed blockers in parts 1 to 3 are the author's own measurements (`response.md`, "Speed of
the two paths this round touched"; the task statement for dashboards and monitors). I did not
re-measure them (section "Measurements"): the rubric has one level for the Speed row and no
tolerance, and none of these rows is covered by the B1 waiver (which names "the dashboards view"
and "chart to table at any size" as not waived). A second session, alternating and on a quieter
machine, is the cheapest way to settle the two that are 2 to 5 ms over; the others are 17 to
97 ms over and need work.

---

## Part 1. Explore, Help, Settings, the command palette

### State of each earlier finding

| Finding | State | What I saw (running view, `70d3d71`) | Image |
|---|---|---|---|
| B1 many-series paint | Not judged here | Ruled on in `../chart-speed/` | |
| B2 "Show 50 more of 200" hit area | **Fixed** | 200 series, table form, coarse pointer, 400 and 320 px: every point from 22 px above to 20 px below the button's centre belongs to the button (45 px); a tap 20 px above the centre showed the next 50 rows (62 to 112 rows) at both widths | `E-B2-tap-20px-above-showed-50-more-400-coarse.png` |
| B3 a reload lands at the top | **Fixed** | Reloaded scrolled down, read 4 s later: Explore 36 (chart and legend end), the table of 200, Help, a dashboard, a monitor; 1500 fine, 400 fine, 400 coarse in Blink: 18 of 18 landed on the same scroll position with the anchor at the same pixel. Layout shift on those reloads 0 except Help at 400 fine (minor n3 below) | |
| M1 palette only by keyboard; "Copy a link" had no control | **Fixed** | "Copy link" in the page head; a tap at 400 px coarse copied the address and the button read "Copied" with the focus on it. Copied text was the page's address with the form's query and range | `E-M1-copy-link-tapped-400-coarse-light.png` |
| M2 text form and accessible name without the day and the warning | **Fixed** | Text form: "… /s, 18 Nov, 09:30 to 12:30, one value every 15 s." The plot's name: "… 18 Nov, 09:30 to 12:30. 4 series …". With a warning (`/__mock/warn`) the name ends "The API sent a warning: the result may be incomplete." and the text form's second line is the head's sentence with the API's words | `E-M2-text-form-day-and-warning-1500-light.png` |
| M3 five states not imaged | **Fixed** | `compare/` has `partial-answer`, `waiting-10s-alternative`, `stopped-at-60s`, `busy-asking-again`, `api-unreachable`, `sign-in-api-unreachable`, both themes, 1440 and 400 px | `compare/app-v9-*` |
| m1 empty head without range | **Fixed** | "18 Nov, 09:30 to 12:30 · every 15 s · updated just now" | `E-m1-empty-head-has-range-1500-light.png` |
| m2 Step placeholder | **Fixed** | No placeholder; "Empty: automatic, now 15 s." | `E-explore-36-1500-light.png` |
| m3 Tab onto the palette's list | **Fixed, with a note** | Tab from the field no longer lands on the list. It leaves the page: the focus goes to the browser (the document's `activeElement` is `body`, no ring on the page), and the palette stays open with its first row highlighted. That is how a modal dialog with one focusable element behaves in Chromium; Shift+Tab returns to the field. Not a finding | `E-m3-palette-after-tab-1500-light.png` |
| m4 copy from the palette says nothing; placeholder names a command | **Fixed** | The command presses Copy link; where the browser refused (no clipboard permission in the test context) the button read "Could not copy" with focus on it. No placeholder. See n2 for the wording | `E-m4-could-not-copy-1500-light.png` |
| m5 table "< 1" | Not fixed (follow-up) | 15 of 36 rows still "< 1" | `E-m5-table-36-still-lt1-400-coarse-light.png` |
| m6 Table / Text / JSON after a failure | Not fixed (follow-up) | Table form after a timeout: the message alone, the previous rows gone | `E-m6-failed-after-result-table-1500-light.png` |
| m7 320 px legend drops a label | Not fixed (follow-up) | Other opened at 320 px: "/cart · checkout" three times, "/pay · checkout" three times | `E-m7-legend-320-names-repeat.png` |
| m8 Other cannot be closed | Not fixed (follow-up; the system's) | not re-checked | |
| m9 the address does not carry the map | Not fixed (follow-up; the system's) | not re-checked | |
| m10 sign-in checkbox | **Fixed** | "Show the key" | |
| m11 range across midnight | Half fixed, as the author says | The chart's head and the text form still read "18 Nov, 18:49 to 00:49" for 18 Nov 18:49 to 19 Nov 00:49. Now that the text form carries a day (M2), this text form names the wrong day for the end of the range: it is the text a person copies into a note | `E-m11-range-across-midnight-head-1500-light.png` |
| m12 no banner when the API is unreachable | Fixed by the author's account; not re-checked by me | | `compare/app-v9-api-unreachable-*` |
| m13 15 px fields on a phone | Follow-up (needs a device) | | |

No earlier finding regressed.

### Blockers

**E-B1. "Show 50 more" is over its budget (the author's measurement).**
- Rubric: Speed: blocker. README, budget row "Changes something local: chart / table / text … 100 ms".
- What a person sees: pressing "Show 50 more of 200" under the table, the rows arrive a little
  after the budget: 102 ms (median 77, worst 117) on the desktop and 105 ms (93, 192) on the
  phone, 75th percentile of 20 runs each, all 40 runs at a load under the core count
  (`response.md`, measured here by the author, after only).
- Where: `/explore?…&view=table`, 200 series, both layouts.
- Why a blocker for so little: the row has one level and no tolerance, and it is outside the B1
  waiver ("not waived: chart to table at any size"; this is the same table). The first review's
  point stands that a row this close to its limit is not settled by one session on this machine:
  a second session, alternating with the build before, would settle it either way.
- Smallest change: a second session; if it holds, paint the next 50 rows' first screen first
  (the budget row's "coarse first, refined in place") or render the 50 rows with less work per
  row.

### Majors

None.

### Minors (new in this round)

| # | Rubric row | What a person sees | Where | Image | Smallest change |
|---|---|---|---|---|---|
| n1 | Words (m11 made worse by M2) | The text form now carries a day, and for a range across midnight it carries only the first one: "18 Nov, 18:49 to 00:49" for a range that ends on 19 Nov | `/explore`, any range across midnight, head, plot name and text form | `E-m11-range-across-midnight-head-1500-light.png` | Write both days when they differ, in the one place (`rangeWords`) the head, the name and the text form share |
| n2 | Words | When the browser refuses the clipboard, Copy link becomes "Could not copy": a statement on a button, with no next step (the address bar has the link) | Explore head, from the palette or the button | `E-m4-could-not-copy-1500-light.png` | Keep the button "Copy link" and put the failure under it as a notice: "Could not copy. The address bar has the link." (Notice) |
| n3 | Narrow and zoom (load shift; evidence) | On Help at 400 px the page moves down about 100 px about 0.1 s after it is drawn: layout shift 0.1198 on every first load (4 of 4) and on 2 of 4 reloads; 0.0439 at 1500 px on 2 of 4 reloads. The entry's source is `main`, moved from y 48 to 150: the development mock's banner is inserted above the page after the build-information probe answers. Not on a deployment (no mock banner), so I do not count it against the app; but it means the mock cannot show this row passing on Help, and `response.md`'s "Help … shift 0.0000" is not what I read | `/help`, 400 px, fine pointer, development mock | (none) | Reserve the banner's place in the first frame, or draw it only on pages that wait for the probe anyway (Explore does not shift) |

## Part 2. Dashboards, read-only (first review)

The person (the author's sentence): someone on call opening their service's dashboard to read,
panel by panel, whether it is healthy over a time range.

What holds, and it is most of it: the list folds well at 400 px; empty, first run, error, no
permission and a missing id each say what happened and what to do, with a standalone next step;
panels keep their reserved height, so nothing moves when answers arrive (layout shift on load and
reload at most 0.004 here); a reload lands where it was at both layouts and with a coarse pointer
in Blink; with a coarse pointer at 400 px every visible control on "Services overview" and
"Service: rate, errors, duration" owns at least 44 px round its centre with nothing over it (66
and 117 controls, each scrolled to the middle of the window and probed); nothing scrolls the page sideways at 320 or 400 px or at 200% zoom on the list, "Services
overview" or "Pod capacity", and no text is under 11 px; every control is reached by Tab in reading
order with a ring (the legend row's ring is drawn by its cells, as in Explore); while a new range
waits every panel keeps its answer under "Showing the previous range" with its own Cancel; the
twelve-panel dashboard reads well in both themes at both widths.

### Blockers

**D-B1. A dashboard an agent wrote is shown as if a person wrote it.**
- Rubric: Agent content ("Is everything an agent wrote marked where it is read … Does any agent
  text appear as a status word, figure or title unmarked?"): blocker. README, Words: "Anything an
  agent wrote says so where it is read, not once per page"; "It never appears as a status word, a
  stat, a title or a measured figure without that marking."
- What a person sees: "Service: rate, errors, duration" says once, in the line under its title,
  "Revision 1, changed 18 Nov 13:20 by incident-agent (agent)." Revision 1 is the dashboard's
  first: an agent wrote all of it. Below that line nothing says so: the title, the intent
  ("Answers: is this service healthy, and which route or status is the cause when it is not?"),
  every panel's title and its explanation ("The two moving apart means a slow tail."), and the
  thresholds behind the stat's status "Within its thresholds" read with the same authority as a
  dashboard a person wrote and reviewed. On the list the intent of that dashboard is shown in the
  Intent column with nothing beside it; the agent is named only in the Changed column. No "Not
  verified", no left rule, nowhere to confirm it.
- Where: `/dashboards?id=service_red` and its row in `/dashboards`, every width and theme.
- Image: `D-B-agent-written-dashboard-unmarked-1500-light.png`; the author's
  `app-dashboards/09-dashboard-variables-*`.
- Note for a second reader: the system writes the rule for claims and sentences; it does not say
  in so many words that a dashboard spec is agent text. I read the rule's own list (title, status
  word, stat) as covering it: a person on call acts on a status an agent's threshold produced.
  If the system's owner decides otherwise, this becomes a question for `project/README.md`, not
  a fix here.
- Smallest change: while the current revision is an agent's and no person has saved over it, mark
  it where it is read: the provenance line as the Claim component writes it ("Agent: written by
  incident-agent. Not verified.") with the agent's left rule on the intent and on each panel's
  explanation, and the same mark in the list's Intent cell.

**D-B2. Panels are painted late and the waiting state comes late (the author's measurement).**
- Rubric: Speed: blocker. Budget rows "Receives a result … 100 ms after it arrives" and "Runs a
  query: send the request and show the region's waiting state, 100 ms".
- What a person sees: on "Services overview" (twelve panels) the slowest panel is painted 144 to
  197 ms after its answer arrives, and after a change of range every panel is marked as waiting
  127 to 165 ms after the press (the author's figures, 75th percentile; not re-measured here).
  Not covered by the B1 waiver, which names "the dashboards view" as not waived.
- Smallest change: an engineering one: draw the panels that are on screen first and the rest
  after the frame (each is a chart of its own), and mark the region waiting in the press's own
  frame before anything else is done.

### Majors

**D-M1. Panels of a kind not drawn, the text note and the dashboard's text form are the model's raw digest.**
- Rubric: Type ("No capitals"): major; and the same text fails Text form ("Does the digest carry
  the same information as the visual form?": major) and Consistency ("each event has one time"):
  major. One finding, one fix.
- What a person sees:
  - The heatmap panel "Request duration distribution" shows a Markdown table in mono:
    "## [OUTLIER] Request duration distribution — durations (heatmap, s)", "| 0.05 | 614.2 | 502.7 |
    632.4 | 572.9 | up +10% | - | outlier z=-5.353 |". Capitals ("[OUTLIER]"; "[NO DATA]" in the
    text form); figures with no unit (614.2 of what: requests per second in that bucket?); a
    statistical "outlier" on each of four latency buckets, which differ from each other by
    construction, flagged at the top of the panel as if something were wrong.
  - The text note "How to read this" shows its Markdown: "## How to read this — notes (text)",
    "above **1.2 cores** for an hour".
  - "Text" (the dashboard's text form) is the same digest for the whole dashboard, in a `pre` that
    does not wrap: at 400 px it is 1,401 px wide in a 366 px box, so the sentences of each panel
    ("Container restarts per second. Nothing h…") and the table's last columns are behind a
    sideways scroll; each table stops at five rows with "(7 more series not shown)", where the
    panel's legend lists all twelve; its range line reads "range 2026-11-18T09:30:00.000Z →
    2026-11-18T12:30:00.000Z" where the page says "18 Nov, 09:30 to 12:30", and "rev 48e32c11c2b1"
    where the page says "Revision 1".
- Where: `/dashboards?id=pod_capacity` (Panels and Text), any dashboard's Text; both themes, both
  widths.
- Images: `D-M-heatmap-panel-raw-digest-1500-light.png`,
  `D-M-text-note-raw-markdown-and-panel-states-1500-light.png`,
  `D-M-dashboard-text-form-cut-at-400-coarse-light.png`; the author's `13-dashboard-text-*`.
- Smallest change: render, do not print. A text note's Markdown as text (headings as headings,
  emphasis as weight). For a kind not drawn, the sentence that says so and the panel's legend as
  the system's table (bucket, unit in the head, last, min, max), without the model's outlier
  notes. For the dashboard's text form, the panels' own text forms (Explore's sentences) in page
  order, wrapped at `measure`, with the page's dates. Keep the model's digest for "Copy for an
  agent" if it is wanted, and say that is what it is.

**D-M2. The same service has a different colour in each panel of one dashboard.**
- Rubric: Charts / Many series, as a question for the system: major (no colour names the wrong
  series inside a panel, so not the blocker clause).
- What a person sees: on "Services overview", read across the Traffic and Latency rows:
  catalog is the first (blue) slot in "Requests by service", the second (orange) in "Errors by
  service" and the third in "p95 latency by service"; checkout is purple, blue and blue. A person
  reading the dashboard "panel by panel" (the author's sentence) and carrying "blue is catalog"
  from one panel to the next reads the wrong service. Each panel follows the algorithm (largest
  first, per panel), and the system says a panel stores its map with the panel; this dashboard
  stores none, and a read-only app cannot save one.
- Where: `/dashboards?id=services_overview`, both themes, both widths; also pods across "CPU by
  pod" and "Memory by pod".
- Image: `D-services-same-service-three-colours-1500-light.png`,
  `D-services-1500-dark.png`.
- Smallest change: when panels of one dashboard share a label set (here `service`), seed every
  panel's map from one dashboard-wide order (largest over the dashboard first), so a service has
  one colour on the page; that is a rule the system's Chart README does not yet state ("A view
  owns a map"), so it goes to the system's owner with the case.

### Minors

| # | Rubric row | What a person sees | Where | Image | Smallest change |
|---|---|---|---|---|---|
| d1 | Words (Stat: "then what it is measured against") | "Within its thresholds" names no threshold. Error ratio's thresholds are in its prose; Requests, p95 latency, Pods up and Memory in use say nothing of theirs | stat panels | `D-services-health-row-1500-light.png` | "Below 2% (worth a look) and 5% (an incident)" from the spec |
| d2 | Detail (baselines) | In a row of stats the figures sit at different heights: a one-line explanation puts "293 ms" 18 px higher than "932 req/s" beside it; the same for the plots of Traffic, and the "Open in Explore" links of a row | Health and Traffic rows, 1500 px | `D-services-health-row-1500-light.png` | Reserve the explanation's two lines in a row, or put the explanation below the figure |
| d3 | Feedback / Stale data (wording) | While a new range waits each panel says "Showing the previous range" but nowhere says which: the fields above already show the new range and the panels' heads carry no range | `11-dashboard-waiting-*` (author's) | `app-dashboards/11-dashboard-waiting-light-1440.png` | "Showing 18 Nov, 09:30 to 12:30, the previous range" in the head |
| d4 | System (component) | "Text form" under each panel is the system's `vz-details` summary drawn without a marker: at rest it reads as a grey label, not a control | every panel | `D-services-health-row-1500-light.png` | The system's: give `vz-details > summary` its disclosure triangle (it sets `display: inline-flex`, which hides the marker) |
| d5 | Words | Error states say "Nothing was changed" twice (the API's detail, then the app's sentence) | list error, panel errors | author's `05-list-error-*` | Drop one |
| d6 | Detail | First run is an ordered list of one item ("1 This app reads dashboards …") | `04-list-first-run-*` | author's | A sentence |
| d7 | Words | Empty panel: "Nothing matched this panel's query in 18 Nov, 09:30 to 12:30" ("between … and …"); its explanation above says "Nothing here means no pod reports restarts", the empty state says to check the metric name: two readings of one empty panel | Pod capacity, Restarts by pod | `D-M-text-note-raw-markdown-and-panel-states-1500-light.png` | One sentence, from the panel's own explanation when it has one |
| d8 | Detail | "8 of 12 rows, highest Requests first" on the Routes table with no way to see the other four | Services overview, Routes | `D-services-…` (p3, not saved) | "Show 4 more", as Explore's table has |
| d9 | Detail | The search's placeholder "checkout" reads like a typed value at a glance (the same thing Explore's step field was fixed for, m2) | `/dashboards` | author's `01-list-*` | No placeholder, or a hint in the label |

## Part 3. Monitors (first review)

The person (the author's sentence): someone on call, often on a phone at night, who has been
notified: which monitor is firing, since when, is anyone on it, what does the query look like
against its threshold; then acknowledge or silence, with a way back.

What holds: the first screen at 400 px answers the sentence in order (name, "Firing since 09:47
(38 min)" with its mark, "Not acknowledged. Notified checkout-oncall … repeats at 13:47", then
Acknowledge, Silence…, Refresh); Acknowledge is the one toned button; "Silence…" opens a menu
that is a bottom sheet with a coarse pointer, with a sentence saying what silencing does and a
yellow "Silence for 1 h"; after an action `vz-done` takes the button's place and the state line
keeps its words and takes the new mark (two bars for silenced), as State, "After an action, with
undo" asks; a refused write is a notice at the actions with the button back; a key without
`monitors:ack` sees the actions disabled with the reason before any press; the list orders
attention first and folds at 400 px; history uses the Timeline's marks; the chart labels the
threshold and the "Above" and "Fired" markers in words.

Seen and measured here in the running view: by keyboard alone, Tab goes name of page, then
Acknowledge, Silence…, Refresh, the range, the query well (a scroller, a tab stop), the chart,
its legend, "The chart as text", "Open in Explore", "Open the runbook", the text form, each with a
ring (the legend row's by its cells); Enter on Acknowledge put "Acknowledged by you at 13:52" with
"Unacknowledge" in its place and the focus on Unacknowledge, the state line kept "Firing since …"
and took the acknowledged mark, and no live region spoke; Enter on "Silence…" opened the menu
with the focus on the chosen "1 h", arrows moved, Escape closed it and gave the focus back to
"Silence…"; "Silence for 1 h" put "Silenced by you until 14:52" with Undo and the focus on Undo;
the "Undo is open until 13:53 (58 s left)" line is not a live region, so its count is not read
out every second. With a coarse pointer at 400 px, every visible control on the list and the
monitor page owns at least 44 px round its centre with nothing over it. Layout shift on the
list's first load at 400 px: 0. A reload lands where it was (Part 1, B3 table).

### Blockers

**M-B1. Opening a monitor and painting its chart are over their budgets (the author's measurement).**
- Rubric: Speed: blocker. Rows "Moves to a view whose data is not loaded … 100 ms" and "Receives
  a result … 100 ms after it arrives".
- What a person sees: from the press on a monitor's name to its page with its waiting state,
  117 ms on the desktop and 146 ms on the phone; its chart painted 143 / 122 ms after the answer
  arrives (the author's figures, 75th percentile; not re-measured here). A one-series chart, so
  this is not B1's many-series cost.
- Smallest change: engineering: show the page from the list's cached row in the press's frame
  (the name and state line are already known) and load the monitor chunk ahead (on the list's
  first paint); find what a one-series chart spends 120 to 140 ms on after its answer.

### Majors

**M-M1. One event, two times; and the API's advice for an action the app does not have.**
- Rubric: Consistency ("does each event have one time"): major (a person would not act on the
  wrong one); Words.
- What a person sees: Undo pressed after its window: the notice reads "Could not undo the
  silence. The API said: the undo window closed at 2026-11-28T10:26:46.032Z; expire the silence
  instead (undo_expired with HTTP 410). The undo window had closed, so the silence stays until
  11:25." and the line under it "The undo window closed at 10:26. … ending it early is not in
  this app yet." The same moment as an ISO timestamp and as "10:26" on one screen; and the API's
  "expire the silence instead" tells the person to do something the line below says they cannot.
- Where: a monitor after "Silence for 1 h" and a late Undo, both widths and themes.
- Image: the author's `app-monitors/07-undo-expired-light-400.png` and `-1440`.
- Smallest change: say it once in the app's words: "Undo had closed at 10:26. The silence stays
  until 11:25." Keep the API's code for the text form or a details line, not its prose.

**M-M2. The firing monitor's value has no unit.**
- Rubric: Words ("Major: a number without a unit").
- What a person sees: "Checkout 5xx ratio": Value "0.0837", threshold "> 0.02 for 5m", chart axis
  0.000 to 0.100 with no unit, legend "Last 0.004", history "Fired at 0.0837." Its own
  description says "Above 2 % customers are failing to pay": the person has to turn 0.0837 into
  8.4% themselves, at night, to compare it with the sentence that tells them what it means.
- Where: `/monitors` (Value, Threshold) and the monitor's page (chart, legend, alerts, history).
- Image: the author's `app-monitors/01-list-*`, `03-monitor-firing-*`.
- Smallest change: carry the query's unit through the monitor views as Explore does (a ratio as
  %, "8.4%", "> 2% for 5 min"); where the API gives none, the chart's "number" with the unit
  select, as Explore offers.

### Minors

| # | Rubric row | What a person sees | Where | Image | Smallest change |
|---|---|---|---|---|---|
| o1 | Words | "for 5m" in Threshold beside "For 5 min" on the same list of facts; minutes are "min" | list, "What it watches" | author's `03-*` | Write the rule's duration as the app writes durations |
| o2 | Words | "Message: Checkout is failing {{ $value \| humanizePercentage }} of requests": the template, unrendered | "What it watches" | author's `03-*` | Label it "Message template", or show it as it was sent at 09:47 |
| o3 | Colour / Status | "Payments errors: Cannot be evaluated" has the critical mark of a firing monitor; the Status component gives unknown a dash | list | author's `01-list-*` | The unknown dash with "Cannot be evaluated", or decide in the system that a monitor that cannot watch is critical |
| o4 | Detail | In a notice the critical mark sits at the vertical middle of a six-line paragraph, not on its first line; "Dismiss" is beside the text in one notice and under it in the next | write failed, undo expired, 400 px | author's `07-*`, `08-*` | The system's Notice: the mark on the first line's x-height |
| o5 | Words | "Changed: changed by key:lee at 25 Nov 10:25"; "Acknowledged: not acknowledged"; the list error starts lower-case with the API's words ("the ruler did not answer in time; nothing was changed") and repeats "Nothing was changed" | monitor page, list error | author's `03-*`, `11-*` | One sentence each, sentence case |
| o6 | Detail | The query well is cut at its right edge ("…service="checkou"): it scrolls sideways and is a tab stop, but nothing on screen says there is more | monitor page, both widths | author's `03-*` | The strip's `rule-control` scroll edge while there is more, as the system asks of a strip that scrolls |
| o7 | Detail | Empty (first run) is an ordered list of one item | `12-empty-*` | author's | A sentence |
| o8 | Consistency (evidence) | In every image the firing monitor reads "Value 0.0837 … Evaluated every 1 min, last at 10:25" while its chart, from the same query, reads 0.004 at 10:25 and the line has been under the threshold since about 10:00. This is the mock (its alert states are fixed at start, `app/README.md`), not the app; but it means the Consistency row cannot be judged from these images | `03-*` to `09-*` | author's | Let the mock evaluate its rules over its own series, or make the review images over a range where the incident is still on |

## Part 4. The waiting line's last frame

**Approve.**

What the rules ask: "over 400 ms: `vz-progress` over the top strip of the region … kept at least
300 ms once shown"; "Receives a result: paint it"; Principle 5, "Words about data describe the
data on screen, never the request in flight"; Feedback, "accurate". So the line has to appear at
400 ms, stay 300 ms, and once both are true it has no reason to be over a finished result: a frame
that shows the new chart with "Waiting for the query." over it is a frame whose words describe a
request that is no longer in flight.

What the records show (`frames-desktop.json`, `frames-phone.json`, `summary.txt`; read in full for
the 200-series runs and in the summary for the rest):
- Long wait (line up more than 300 ms when the answer comes; 200 series): before, the frame that
  showed the new chart still showed the line, and the next frame came 50 to 133 ms later (the
  page's second render for one answer); after, line gone in the same frame as the new chart in
  3 of 3 desktop runs and 2 of 3 phone runs; the third phone run is the minimum case (line shown
  at 403 ms, chart at 703 ms: 300 ms not yet up) and the effect took it 67 ms later, as the
  minimum requires.
- Short wait (36 series, answer inside the first 300 ms): unchanged by the change: the line stays
  over the new chart until its 300 ms are up, in both builds. That is the system's rule, not this
  change's.
- The minimum held in every run of both builds at both layouts (299.9 to 300.1 ms where the
  answer came early); the line's words and the head's labels were the same in every frame; no
  frame showed "Showing the previous query" falsely.

Two things for the author, neither changing the verdict:
- Phone, 36 series, "after" run 1 held the line 367 ms (four frames past its minimum) and run 3
  333 ms; "before" at most 317 ms. That path is the effect's timer, which this change did not
  touch, and three runs cannot say whether it is load; worth five more runs.
- The hook calls `setShown` during render after reading `performance.now()` and a ref. Under
  `StrictMode` (development only) the two renders can decide differently across the 300 ms mark;
  production renders once. The same hook drives every dashboard panel's line, the list's and the
  shell's key check: the records cover Explore only, and I saw the dashboards' lines only in the
  author's images (`11-dashboard-waiting-*`, `12-dashboard-first-load-*`), where they sit over the
  strip right of the axis and say true things. I did not frame-record a dashboard.

---

## Measurements

**None taken by me.** The machine lock was held by other sessions' speed runs (B1's) for most of
this review, and the brief says to cut measurement breadth before composed-screen judgement. The
speed findings above are the author's figures, judged by the rubric, and say so. Layout shift and
reload landings, which are judged at any load, are measured here (Part 1, B3 and n3; Part 2).

## What I did not check

- Any timing of my own (above). A device, Safari, Firefox, a screen reader by ear.
- Explore's m8, m9, m12 again; Settings beyond its earlier state (no finding was open on it).
- Dashboards: variables whose values cannot be listed, a spec the model refuses, the 60 s stop of
  a panel, a cancelled panel, "Run this panel again" (the author lists them as not imaged; I did
  not make them), greyscale, hover and pressed fills.
- Monitors: a history over 200 entries, the waiting states (not imaged by the author, not made
  by me), greyscale, 200% zoom, the dark theme in the running view (the author's dark images
  only), the silence sheet's rows by probe (the author's 400 px image only).
- The waiting line on dashboards frame by frame.
- `npm test`, the e2e suites, the mutants: not run by me.

## The author's claims against what I found

Read after the Explore findings were written.

| Claim (`response.md`) | Holds? |
|---|---|
| B2 fixed: 44 px with either pointer, taps 16 px above and below | Yes: 45 px, tap 20 px above worked at 400 and 320 |
| B3 fixed at 1500, 400 fine and 400 coarse in Blink, shift 0.0000 on Help | Landing: yes, 18 of 18. Shift on Help: no, 0.1198 on 2 of 4 reloads and every first load at 400 px fine (n3; the mock's banner) |
| M1 fixed: Copy link, "Copied" or "Could not copy" | Yes (n2 on the wording) |
| M2 fixed | Yes |
| M3 fixed | Yes, the six states are in `compare/` |
| m3 "Tab leaves the field for the next control" | It leaves the page for the browser; there is no next control in the dialog. Fine |
| m11 half: "where the page writes a range … both days; the chart's own head does not" | Yes; and the text form shares the chart's half (n1) |
| "Show 50 more" over by 2 and 5 ms, a follow-up | The figures are the author's; by the rubric that is a blocker, not a follow-up (E-B1) |
| m12 fixed: the banner "is inserted above the page, so the page moves down when it appears" | Not re-checked; the same insertion is what shifts Help with the mock's banner (n3) |

## Housekeeping

- Written in the repository: this file and `rereview-images/` (21 PNG files). No commit, no push,
  no Cloudflare call.
- The frozen worktree at `70d3d71` (in my scratch area) is removed; the servers I started (two
  mocks, two previews) are stopped. Every browser job ran under the machine lock, one at a time.
