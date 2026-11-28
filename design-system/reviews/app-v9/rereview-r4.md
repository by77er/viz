# Design re-review, round 4: dashboards and monitors

Reviewed 2026-11-28, about 16:30 to 17:40 UTC, by an independent reviewer: an agent session that
did not write the app, the design system or any of the PR files, and was not given the author's
reasoning. Findings were formed from the rubric, the running view and my own images and timings;
the author's dispositions (`app/README.md`, "The third design review: dashboards and monitors";
`reviews/app-dashboards/PR.md` and `reviews/app-monitors/PR.md`, "Third design review") were read
only after the findings were formed (section "The author's claims against what I found").

- **What was reviewed.** `app/` at commit `3bed27a`, in a frozen worktree in my scratch area,
  built there (`npm run build`), served by `vite preview` over the development mock, and over a
  second mock started with keys for each scope case (`--require-token`, `--readless-token`,
  `--dashboards-token`, `--monitors-token`, `--oncall-token`). On this commit both views are in
  the navigation (the release switch is on the UI branch only); that is not a finding.
- **Scope.** Part 2 (dashboards) and part 3 (monitors) of `rereview.md`: the state of D-B1, D-B2,
  D-M1, D-M2, d1 to d9, M-B1, M-M1, M-M2, o1 to o8, and what is new. Explore, Help, Settings and
  the palette are out of scope.
- **Ground truth.** `project/review.md` (rubric), `project/README.md` (rules; "Words";
  "Responsiveness and feedback"), `project/method.md`, `tokens.json`,
  `project/components/Chart/README.md` ("A view owns a map", "The algorithm", "Off screen"),
  `project/components/Menu/README.md` ("Where it opens"), `tools/speed.mjs` (its definition of
  "end of the frame"); AGENTS.md "Design changes"; the session rule (SR) of
  `reviews/chart-speed/third-review.md` §4.
- **How.** Playwright (`chromium.launch()`, headless shell), one browser job at a time under the
  shared machine lock, Cloudflare credentials removed, no Cloudflare call, no commit. 1500 px with
  a fine pointer and 400 px with touch emulation (coarse pointer checked by `matchMedia` in every
  probe), both themes; 1440, 1280, 1024 and 640 px for the menu; 200% zoom as 750 CSS px at device
  scale 2; reduced motion; keyboard only (Tab through every stop of an agent's dashboard and of a
  firing monitor, the ring read as computed). Hit areas at 400 px coarse: every visible control of
  six pages (three dashboards, the dashboards list, a monitor, the monitors list) scrolled to the
  middle of the window and probed point by point round its centre. No position or size was read
  across a reload under `hasTouch`.
- Images I cite are mine, in `rereview-r4-images/` (27 PNG files, 1.5 MB), unless an author's file
  is named.

## Verdicts

| Part | Verdict | Why, in one line |
|---|---|---|
| **Dashboards** | **Reject** (on one speed row; everything else is approve-with-changes level) | D-B1, D-M1 fixed; D-M2 fixed as a proposal for the system. But the speed fix moved the cost to where a person scrolls: a panel scrolled into view while the dashboard loads stays an empty box for 200 to 460 ms (new D-B3, Speed: blocker). One major (D-M3, a consequence of D-M2 for the system's owner) |
| **Monitors** | **Reject** | The silence menu runs 29 px past the right edge of the window at every width from 640 to 1500 px and at 200% zoom: the page scrolls sideways and the menu's sentence is cut (new M-B2, Narrow and zoom: blocker; it is in the author's own image `app-monitors/05-silence-menu-light-1440.png`). The chart's paint after its answer is not met on the desktop by the session rule: Y 74, my sessions 108 and 109, pooled 105 against 100 (M-B1, Speed: blocker). M-M1 and M-M2 fixed; no majors |

The verdict on both parts depends on how the author's new timing definition is read (next
section). I accept it for this review; if the system's owner does not, two more rows fail
(dashboards "every panel waiting" 139 to 148 ms; monitors "opens the view" 172 to 196 ms by the old
definition), which does not change either verdict.

## The author's timing definition (asked of me)

**What changed.** For "Range pressed: every panel waiting" (dashboards) and "Opens the view"
(monitors) the harness now takes, when the state was put in the page in the press's own task
(before any frame began after the press, checked per run: 20 of 20 in every session I ran), the
press's next paint as Event Timing reports it (`startTime + duration` of the press's events). The
old definition, printed beside it (`rangeBusyTask`, `viewChangeTask`), is the one `tools/speed.mjs`
uses everywhere: a task posted from the animation callback of the frame that first shows the state.

**Ruling: it matches the budget's wording; it is not yet the system's harness.**
- The rows say "send the request and **show** the region's waiting state" and "**show** the shell
  … and the region's waiting state", 100 ms. What a person sees is the frame that is painted. When
  the state is in the DOM before the press's task ends, the next frame contains it, and Event
  Timing's duration ends at that frame's paint. That is the quantity the row names, measured more
  directly than speed.mjs's proxy.
- The old definition measures something else: its posted task runs after every task already
  queued, here the requests' task and the monitor body's render that the page queues after the
  frame. On my runs it reads 100 ms later than the paint (monitors desktop 188 against 88; phone
  196 against 88). Those 100 ms are real main-thread work, but they fall after the frame that shows
  the state; a second input in that window would wait, and INP (200 ms) is the row for that.
- Conditions: (1) it is valid only when the state is drawn in the press's own task; the harness
  checks it and falls back otherwise, as it should (session Y's phone runs show what happens when
  the check is wrong: the author found and corrected it before Z). (2) Event Timing reports in 8 ms
  steps and only events of 16 ms or more; a 75th percentile within 8 ms of the limit is unsettled
  by construction. (3) The rubric accepts "`tools/speed.mjs` or a harness that measures the same
  way". This one no longer does, so the system's owner should adopt the definition in speed.mjs
  (it reads every view late in the same way) or say no. Until then both figures are printed, as
  the author does.

## State of each earlier finding

### Dashboards

| Finding | State | What I saw (running view, `3bed27a`) | Image |
|---|---|---|---|
| D-B1 agent's dashboard unmarked | **Fixed** | "Service: rate, errors, duration" (revision 1, by incident-agent): the head is inside the agent's rule under "Agent's dashboard, written by incident-agent — Not verified"; every panel title carries the rule (and "The agent's title:" for a screen reader); every explanation reads "Agent: … Not verified." in the rule; the stat's thresholds are their own ruled line "Agent's thresholds: above 2% (warning) and above 5% (critical). Not verified."; the list's Intent cell is ruled with "Agent: … Not verified."; the panel and dashboard text forms say "Agent:" and "Not verified". A person's dashboard has none of it. Both themes, 1500 and 400 px | `D-B1-agent-dashboard-marked-1500-light.png`, `-400-light.png`, `D-list-agent-intent-1500-light.png` |
| D-B2 panels painted late; waiting state late | **Met for what is on screen when the answer arrives; not met for a panel scrolled into view** (D-B3) | On screen: a panel painted 54 to 98 ms after its answer (desktop), 38 to 53 (phone); every panel waiting 72 / 80 ms after a range press (new definition); first request 87 to 103 ms. Off screen: drawn when idle, 443 to 543 ms after its answer, and 200 to 460 ms after it comes into view during the load. Timings below | |
| D-M1 raw digest | **Fixed** | Heatmap: the system's table (At most, Last, Lowest, Highest, unit in the head, shortest first, a sentence saying the rows are cumulative); text note rendered ("1.2 cores" in weight); panel and dashboard text forms are sentences in page order, every series, wrapped at the measure, with the page's dates; the model's digest only behind "Copy the digest for an agent". Two minors on its words (n-d2, n-d3) | `D-M1-heatmap-table-note-empty-error-1500-light.png`, `D-text-form-unit-wraps-400-light.png` |
| D-M2 one service, three colours | **Fixed in the app, as a proposal to the system's owner** | catalog, auth, orders, checkout keep one colour across Requests, Errors and p95 latency; pods keep one colour across CPU and Memory; both themes. Its consequence for a panel whose largest series differ is D-M3 | `D-M2-colours-across-panels-memory-other-1500-light.png`, `-1500-dark.png` |
| d1 thresholds unnamed | **Fixed** | "Thresholds: below 100 req/s (warning)." under each stat | `D-stat-row-baselines-meta-1500-light.png` |
| d2 baselines in a row | **Not fixed** (follow-up, the system's Panel) | "932 req/s" and "0.40%" sit 18 px below "293 ms" and "12" in the Health row, as before | `D-stat-row-baselines-meta-1500-light.png` |
| d3 which previous range | **Fixed** | "Showing 18 Nov, 09:30 to 12:30, the previous range" in every panel head, with the waiting line, its seconds and Cancel over the strip | `D-waiting-previous-range-1500-light.png`, `-400-dark.png` |
| d4 summary without marker | **Not fixed** (follow-up, the system's `vz-details`) | "Text form" still reads as a grey label | `D-stat-row-baselines-meta-1500-light.png` |
| d5 "Nothing was changed" twice | **Fixed** where I looked (panel error, monitors list error); the dashboards list error not re-made | The monitor's refused write still says it twice: n-o4 | |
| d6 first run as a list | Not checked (no mock hook for an empty dashboards tenant) | | |
| d7 two readings of an empty panel | **Fixed** | "No series matched. Nothing matched this panel's query from 18 Nov, 09:30 to 12:30." under the panel's own explanation | `D-M1-heatmap-…-1500-light.png` |
| d8 cut rows unreachable | **Fixed** | "Show 4 more" under Routes; 44 px with a finger | `D-M2-colours-…-1500-light.png` (bottom) |
| d9 placeholder | **Fixed** | none | |

### Monitors

| Finding | State | What I saw | Image |
|---|---|---|---|
| M-B1 opening and chart paint over budget | **Opening: met** (new definition; Z 80, mine 88: two sessions agree). **Chart paint, desktop: not met** (Y 74, mine 108 and 109; pooled 105, 24 of 60 runs over). Chart paint, phone: met (Y 96, mine 91 agree; my second 115 reported) | Timings below | |
| M-M1 one event two times; advice for an absent action | **Fixed** | Late Undo: "Undo had closed at 16:45, so the silence stays until 17:44. Ending a silence early is not in this app yet. (The API answered undo_expired, HTTP 410.)" One time format, no advice the app cannot follow | `M-M1-late-undo-actions-move-1500-light.png`, `M-late-undo-notice-400-dark.png` |
| M-M2 no unit | **Fixed** | "0.4%", "> 2% for 5 min", axis "%", "> 2% threshold", "Fired at 8.4%", "Message, as sent at 15:47: Checkout is failing 8.4% of requests" | `M-firing-1500-light.png`, `M-list-1500-light.png` |
| o1 "for 5m" | **Fixed** | "> 2% for 5 min" | `M-list-1500-light.png` |
| o2 template unrendered | **Fixed** | "Message, as sent at 15:47" filled, and "Message template" labelled | `M-firing-1500-light.png` |
| o3 critical mark on "Cannot be evaluated" | **Fixed** | the unknown dash | `M-list-1500-light.png` |
| o4 notice mark centred | **Not fixed** (follow-up, the system's Notice) | the mark at the middle of a five-line notice at 400 px; "Dismiss" centred beside it | `M-late-undo-notice-400-dark.png` |
| o5 wording | **Half fixed** | The list error is one sentence. "Changed: Last changed by key:lee at 25 Nov 16:37" still says "changed" twice (n-o5) | `M-firing-1500-light.png` |
| o6 query cut | **Fixed** | the query wraps; no longer a tab stop | `M-firing-1500-light.png` |
| o7 first run as a list | **Fixed** | two sentences | (seen, not kept) |
| o8 mock state fixed at start | **Not fixed** (the mock; evidence, not the app) | "Checkout 5xx ratio: Firing since 15:47 (1 h 17 min)", Value 0.4%, threshold "> 2%", the line under the threshold since about 15:57. The value now agrees with the chart; the state does not | `M-list-1500-light.png`, `M-firing-1500-light.png` |

No earlier finding regressed.

## New findings

### Blockers

**D-B3. A panel scrolled into view while the dashboard loads is an empty box for 200 to 460 ms.**
- Rubric: Speed: blocker. Budget row "Receives a result: paint it … 100 ms after it arrives",
  read as the author asked me to rule on it (below).
- What a person sees: they open "Services overview" and scroll straight to Pods (a fling, the End
  key, a jump). "Memory by pod" has its answer and its head says "every 30 s · updated just now",
  but under it is its reserved space with nothing in it, no plot, no legend, no waiting line, for a
  quarter to half a second; then the chart appears. Measured here, 4x CPU and Fast 4G, the press on
  the list, then the moment the panel is answered (still deferred in 30 of 30 runs) a jump to it,
  until the frame after its plot is in the page: desktop 203 to 449 ms (p75 362, 10 runs, load
  0.19 to 0.71) and, 30 minutes later, 217 to 457 ms (p75 382, 10 runs, load 0.48 to 0.84); phone
  152 to 370 ms (p75 313, 10 runs, load 0.71 to 1.56). Three frames each time, so the main thread is
  busy for those 200 to 450 ms (the panels' charts, about 48 ms each at 4x by the author's
  profile).
- Where: any dashboard with charts below the window, during the first 1 to 1.7 s after opening
  (`allPainted` 1.35 to 1.66 s) or after a range change; both layouts.
- Image: none could be taken in the gap (a screenshot forces the frame that draws it); the runs are
  in my scratch records, summarised here. The deferral is the author's (`PanelView.tsx`,
  `DeferredChart`: drawn when on screen, near, or idle).
- How I read the row: the author asks whether the row means "every panel of the page" (then off
  screen fails at 443 to 543 ms) or "a panel on screen" (then met). Neither. The system lets a
  chart off screen be skipped (Chart, "Off screen": `content-visibility: auto`), which the browser
  renders in the next frame when it comes into view. So a panel off screen when its answer arrives
  meets the row if it is painted within 100 ms of coming on screen. It is not: 2 to 4.5 times that.
  The author's own claim "any panel at once when it comes on screen; nothing a person sees changes"
  does not hold during the load. A second reviewer may read a scroll as outside every budget row;
  then this is a major under Feedback (an answered panel shows nothing, with "updated just now"
  over it), and the dashboards verdict becomes approve with changes.
- Smallest change: do not wait for idle time. Draw the off-screen charts one per task straight
  after the on-screen ones, nearest first, so they are drawn before most people scroll; when a
  deferred panel comes into view, draw it before anything else queued. Then measure this path (a
  jump to the lowest chart as soon as it is answered) in `measure-dashboards.cjs`, at both layouts.
  The chart's own cost (C7, the first number format) helps both.

**M-B2. The silence menu runs past the right edge of the window.**
- Rubric: Narrow and zoom ("at 200% zoom … no sideways page scroll"): blocker. README "Nothing
  scrolls the page sideways, at any width from 320 px to 1500 px, at 200% zoom … or a word cut by
  an edge"; Menu: "with their right edges aligned (`data-align="end"`) when there is no room to the
  right".
- What a person sees: "Silence…" sits at the right end of the head; its menu opens with its left
  edge under the button and is 220 px wide, so 29 px of it lies outside the window. The sentence
  that says what silencing does is cut: "Notifications stop until 17:42. The monitor keeps
  evaluatin[g] and stays listed, and its histor[y] says who silenced it." The page gains a sideways
  scroll of 29 px while the menu is open. Measured (menu right edge, window width): 1529/1500,
  1469/1440, 1309/1280, 1053/1024, 669/640, 779/750 at 200% zoom. At 400 px fine pointer it fits
  (362/400); with a coarse pointer it is the bottom sheet and fits.
- Where: any monitor with the actions, every desktop width and 200% zoom, both themes. Present at
  `70d3d71` as well (the source has never set `data-align`); it is in the author's own image
  `app-monitors/05-silence-menu-light-1440.png` and was not caught in round 3.
- Images: `M-silence-menu-past-right-edge-1500-light.png`, `-1440-light.png`,
  `-zoom200-light.png`.
- Smallest change: set `data-align="end"` on the menu when its right edge would pass the window
  (the system's Menu already defines it), and add an overflow check with the menu open to
  `monitors.cjs`.

M-B1 (chart paint, desktop) stands as the second monitors blocker: state table above, timings
below.

### Majors

**D-M3. With one colour map for the dashboard, a panel's largest series can start in Other, and its note says they became larger.**
- Rubric: Many series ("Were the coloured series the largest when they took their colours?"):
  major (no colour names the wrong series). Chart README, "The algorithm", consequences: "on first
  load the eight largest are coloured, by size".
- What a person sees: on "Services overview", "Memory by pod" takes its pods' colours from "CPU
  by pod" (D-M2's map), so its eight coloured pods are CPU's eight, not memory's. The pods using
  the most memory (up to 687 MiB) are in the grey Other band beside coloured pods at 253 MiB;
  "Colour the eight largest" is offered (correctly); and the note reads "4 in Other are now larger
  than a coloured series", where "now" says they grew, but they were larger from the first frame.
- Where: `/dashboards?id=services_overview`, Pods row, both themes and widths.
- Image: `D-M2-colours-across-panels-memory-other-1500-light.png` (bottom right).
- Why a major and not left with D-M2: D-M2's fix is the right call for a person reading panel by
  panel, and the author proposes it to the owner (README, decisions; C1, C2). But the system as
  written says the opposite on first load, and the change ships against it. It needs the owner's
  rule, which the author has already drafted.
- Smallest change: the owner takes the proposal and amends Chart's consequence ("on first load
  the eight largest are coloured, unless the dashboard already gave the series a slot"); the note
  says "4 in Other are larger than a coloured series" (no "now") when the cause is the dashboard's
  map. Approve-with-changes level once agreed.

### Minors

| # | Rubric row | What a person sees | Where | Image | Smallest change |
|---|---|---|---|---|---|
| n-d1 | Detail | A panel's "every 30 s · updated just now" is right-aligned inside a slot as wide as the hidden "Showing 18 Nov, 09:30 to 12:30, the previous range", not inside the panel: in a narrow panel (each stat at 1500 px, every panel at 400 px) it floats mid-head, about 30 to 56 px short of the right edge and far from the left | Health row; every panel at 400 px | `D-stat-row-baselines-meta-1500-light.png`, `D-panel-meta-reserved-slot-400-light.png` | Keep the reserve, but align the meta to the panel's edge (the slot `width: 100%` when it wraps under the title) |
| n-d2 | Words | Heatmap bounds "5ms", "2.5s" with no space; the counts' unit is "/s" ("Last, /s"; "last 614 /s") for requests per second; the text form says "A heatmap, 12 series in s"; in the text form at 400 px "/s" wraps alone onto the next line (a quantity is unbreakable) | Pod capacity, the heatmap and its text | `D-M1-heatmap-…-1500-light.png`, `D-text-form-unit-wraps-400-light.png` | "5 ms", "req/s", "12 buckets of request duration, in req/s"; `vz-qty` round each figure with its unit |
| n-d3 | Text form | The dashboard's text says "Revision 1, changed by Lee." where the page says "changed 2 Nov 08:01 by Lee"; an empty panel's text says "No series matched in 18 Nov, 09:30 to 12:30" where the panel says "from … to" | Text of any dashboard | `D-text-form-unit-wraps-400-light.png` | The page's words in both |
| n-d4 | Detail | A text note's body starts one line below its neighbours' explanations (an empty explanation line is reserved) | Pod capacity, "How to read this" | `D-M1-heatmap-…-1500-light.png` | Reserve no explanation line for a note |
| n-o1 | Words / Consistency | Silenced, not acknowledged: the state line says "Not acknowledged. Notified … at 15:47; no repeats while someone has it." Nobody has it; it is silenced | monitor page after "Silence for 1 h", both widths | `M-silenced-state-line-1500-light.png`, `M-silenced-400-dark.png` | "… no repeats while it is silenced (until 17:44)." |
| n-o2 | Detail (States) | The actions jump: at rest they sit at the head's right; when a notice appears (a refused acknowledge, a late Undo) they move under the state line at the left, about 800 px away, and the state line re-wraps. The button the person wants to press again ("Acknowledge", "Try again" is beside it) is no longer under the pointer | monitor page, 1500 px | `M-ack-refused-actions-move-1500-light.png`, `M-M1-late-undo-actions-move-1500-light.png` | Keep the actions where they were; put the notice under the head across its width |
| n-o3 | States ("replaces its button, in place and at the same height") | At 400 px "Acknowledged by you at 16:42 · Unacknowledge" takes a row of its own and pushes Silence… and Refresh to a second row: everything below moves down 44 px | monitor page, 400 px coarse | `M-sheet-and-acknowledged-400-coarse-light.png` | Let the done state take the button's place in the same row (it fits beside Silence… in 368 px), or reserve the row |
| n-o4 | Words (d5's case) | A refused acknowledge: "The API said: the ruler did not answer in time; nothing was changed (unavailable with HTTP 503). Nothing changed: it is still not acknowledged." | monitor page, write refused | `M-ack-refused-actions-move-1500-light.png` | Drop the second "Nothing changed" |
| n-o5 | Words | "Changed: Last changed by key:lee at 25 Nov 16:37"; history "Went > 2% at 8.4%" (a symbol where a verb's object goes) | monitor page | `M-firing-1500-light.png` | "Changed: by key:lee, 25 Nov 16:37"; "Went above 2% (8.4%)" |
| n-o6 | Detail | At 200% zoom the chart's marker "Firing since 15:47" is shortened to "Firing", dropping the time that tells it from "Above 15:42"; the facts column wraps a word to a line | monitor page, 200% zoom | `M-firing-zoom200-light.png` | Let the marker label take a second line, or drop "since" before the time |

Not findings, for the author and the owner:
- The list's row for the agent's dashboard: its name link carries no rule, its Intent cell does
  ("Agent: … Not verified.") and its Changed cell says "(agent)". I read the row as the place the
  name is read and the row as marked, so this passes the Agent content row; an owner who reads
  "never a title" per element would want the rule on the name too.
- "Not verified" on a read-only app has no way to verify. The author's answer (a person's next
  revision lifts it) is what the rule allows; the system should say so (C6).
- The status words "Within its thresholds" are the app's, measured against thresholds marked as
  the agent's on the line below. I accept that; "Within the agent's thresholds" would remove the
  last doubt.

## Timings (measured here)

`app/e2e/measure-dashboards.cjs` and `measure-monitors.cjs` (one build, 20 runs, no `--compare`:
my sessions have no anchor build, which SR's point 1 asks for, so they give the absolute figure
and no paired difference), 4x CPU and Fast 4G, 4 cores, the 1-minute load recorded with every run.
Session 1 16:46 to 16:55 UTC, session 2 17:21 to 17:29 UTC (35 minutes apart). Every session is
reported. 75th percentile (median, worst), ms.

| Row (limit) | Layout | S1 | S2 | Author's (X, Y, Z) | Decided by SR |
|---|---|---|---|---|---|
| Dashboards: open, shell painted (100; old definition) | desktop | 89 (78, 105) | 104 (89, 127) | X 63, Y 75 | met (X and Y agree; dashboards code is the same in X) |
| | phone | 101 (86, 120) | 108 (92, 136) | X 96, Y 91 | met (X and Y agree). My two sessions are over; all four pooled read 100, 21 of 80 runs over: at its limit |
| Dashboards: panel on screen painted after its answer (100) | desktop | 63 (54, 143) | 98 (71, 153) | 73, 62 | met |
| | phone | 53 (33, 82) | 38 (27, 84) | 48, 40 | met |
| Dashboards: slowest panel, off screen included (context; see D-B3) | desktop | 503 (428, 611) | 471 (396, 568) | 394 | |
| | phone | 543 (469, 609) | 443 (382, 697) | 427 | |
| Dashboards: range pressed, first request sent (100) | desktop | 88 (80, 112) | 87 (73, 109) | 61, 69 | met |
| | phone | 100 (81, 117) | 103 (81, 114) | 83, 83 | met |
| Dashboards: range pressed, every panel waiting (100; new definition) | desktop | 72 (64, 88) | 72 (64, 88) | 48, 64 | met |
| | phone | 80 (64, 96) | 80 (72, 96) | 72, 72 | met |
| … the same by the old definition (`rangeBusyTask`) | desktop / phone | 139 / 148 | 140 / 148 | 107 / 120 | not met if the old definition is binding |
| Dashboards: scroll to a panel answered and not drawn, until drawn (D-B3) | desktop | p75 362 (10 runs) | p75 382 (10 runs) | not measured | **not met** |
| | phone | p75 313 (10 runs) | | | (one session) |
| Monitors: open, page painted (100; new definition) | desktop | 88 (72, 112) | 88 (80, 104) | X 72, Y 64 | met |
| | phone | 88 (80, 104) | 112 (96, 136) | Y 180 (harness defect), Z 80 | met (Z and S1 agree under the corrected harness). Y read 9 of 20 runs by the old definition, which the author found and corrected; the author's pooled 104 includes them |
| … the same by the old definition (`viewChangeTask`) | desktop / phone | 188 / 196 | | Y 144, Z 172 | not met if the old definition is binding |
| Monitors: chart painted after its answer (100) | desktop | 108 (103, 157) | 109 (98, 133) | X 80, Y 74 | **not met**: Y and S1 disagree, S2 third; Y, S1, S2 pooled 105, 24 of 60 over. X is not counted: its build differs in the monitor page itself (the "Message, as sent" row). With X, all four pooled read 103 |
| | phone | 91 (78, 100) | 115 (75, 123) | X 76, Y 96 | met (Y and S1 agree); S2 reported |
| Monitors: Acknowledge pressed, busy painted (100) | desktop / phone | 36 / 50 | 34 / 51 | 32 | met |
| Layout shift (0.05) | all | 0.0000 to 0.0073 | 0.0000 to 0.0073 | | met |

Load: S1 0.12 to 1.83, S2 0.33 to 1.72; no sample above 4 cores; calibration 322 to 467 ms
(context only). My sessions read slower than the author's (by 10 to 35 ms on the rows near the
limit) at similar load; that spread is the reason the session rule exists, and why the opening
rows at the phone layout are best called "at the limit" even where SR calls them met.

## The author's claims against what I found

Read after the findings above were formed.

| Claim | Holds? |
|---|---|
| D-B1: every word of an agent's spec is marked where it is read | Yes (list cell, head, titles, explanations, thresholds, text forms). A ruled agent's note was not on the mock, so not seen |
| D-B2: "Nothing a person sees changes"; "any panel at once when it comes on screen" | No during the load: 200 to 460 ms of an empty panel after a jump to it (D-B3). On-screen rows: yes |
| D-B2: the off-screen row is "not met if the row means every panel" | I rule on a third reading (D-B3): off screen is allowed, as Chart's `content-visibility`, if the panel is painted within 100 ms of coming into view |
| D-M1 fixed | Yes, with two wording minors (n-d2, n-d3) |
| D-M2 fixed as a proposal | Yes; its first-load consequence needs the owner's rule (D-M3) |
| M-B1: opening met; chart paint met (80, 74) | Opening: yes, under the new definition (my 88, 88). Chart paint desktop: not by SR with my two sessions (108, 109; pooled with Y 105) |
| M-B1 phone opening "left for the reviewer to rule" | Met: Y's runs were read by a definition the harness was wrong to fall back to; Z and my S1 agree (80, 88). My S2 read 112 and is reported |
| M-M1, M-M2 fixed | Yes |
| o5 fixed | Half (n-o5) |
| d5 fixed (monitor error included) | Not on a refused write (n-o4) |
| d2, d4, o4: follow-ups, the system's | Agreed they are the system's; not fixed |
| o8 fixed in the mock (the value) | The value agrees with the chart now; the state is still fixed at start, so a monitor reads "Firing" at 0.4% against "> 2%" for an hour |

## What I did not check

- A device, Safari, Firefox, a screen reader by ear.
- Reload landing and load-scrolled layout shift with the pointer coarse in Blink (`tools/audit.mjs`'s
  pass); the measured opening shifts are 0.0000 to 0.0073.
- Dashboards: first run (d6), the dashboards list error, a ruled agent's text note, variables whose
  values cannot be listed, the 60 s stop, a cancelled panel, greyscale beyond two 400 px pages,
  hover and pressed fills by eye.
- Monitors: history over 200 entries, the "Silenced" filter's list, 320 px.
- D-B3 at the phone layout in a second session; any timing on a quieter machine; `npm test`, the
  e2e suites and the mutants (not run by me).
- Tool note: Playwright's full-page screenshot under `isMobile` drew inputs at 32 px on my 400 px
  pages, while the same pages probed without a screenshot have 44 px inputs with `(pointer:
  coarse)` matching. I judged touch sizes from the probes only; a full-page screenshot at the phone
  layout is not evidence of touch sizes.

## Housekeeping

- Written in the repository: this file and `rereview-r4-images/` (27 PNG files, 1.5 MB). No commit,
  no push, no Cloudflare call.
- The frozen worktree at `3bed27a` is removed; the two mocks and two previews I started are
  stopped. Every browser job and build ran under the machine lock, one at a time.
